// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

import { useRepoMapWaitGate } from "../use-repo-map-wait-gate";

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// @testing-library's `waitFor` polls via real `setInterval`/`setTimeout`, which never fire once
// `vi.useFakeTimers()` is active (it has no way to detect Vitest's fake timers the way it does
// Jest's, so it never falls back to timer-advancing mode) -- so `waitFor` alone would hang
// forever under a global `vi.useFakeTimers()`. Flushing one fake-timer tick inside `act` lets
// pending microtasks (the mocked `apiFetch` promises) and the resulting state updates settle,
// then we assert directly instead of polling.
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("requestSubmit", () => {
  it("stays hidden and never checks until a submit is attempted", async () => {
    apiFetchMock.mockResolvedValue({ mapped: false, checkable: true });
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
    await flush();
    expect(result.current.state).toBe("hidden");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("proceeds immediately with no codebase, without fetching", () => {
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("", onProceed));
    act(() => result.current.requestSubmit());
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("proceeds without prompting when the repo is already mapped", async () => {
    apiFetchMock.mockResolvedValue({ mapped: true, checkable: true });
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    act(() => result.current.requestSubmit());
    expect(result.current.state).toBe("checking");
    await flush();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/repos/map-status?codebase=acme%2Fwidgets");
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
  });

  it("proceeds without prompting when the check isn't checkable", async () => {
    apiFetchMock.mockResolvedValue({ mapped: false, checkable: false });
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    act(() => result.current.requestSubmit());
    await flush();
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
  });

  it("proceeds without prompting when the check throws", async () => {
    apiFetchMock.mockRejectedValue(new Error("network error"));
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    act(() => result.current.requestSubmit());
    await flush();
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
  });

  it("shows the prompt on a checkable miss", async () => {
    apiFetchMock.mockResolvedValue({ mapped: false, checkable: true });
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    act(() => result.current.requestSubmit());
    await flush();
    expect(result.current.state).toBe("prompt");
    expect(onProceed).not.toHaveBeenCalled();
  });
});

describe("startNow", () => {
  it("hides the banner and calls onProceed exactly once", async () => {
    apiFetchMock.mockResolvedValue({ mapped: false, checkable: true });
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    act(() => result.current.requestSubmit());
    await flush();
    expect(result.current.state).toBe("prompt");

    act(() => result.current.startNow());
    act(() => result.current.startNow());

    expect(result.current.state).toBe("hidden");
    expect(onProceed).toHaveBeenCalledOnce();
  });
});

describe("startWaiting", () => {
  async function toPrompt(onProceed: () => void) {
    const rendered = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    act(() => rendered.result.current.requestSubmit());
    await flush();
    expect(rendered.result.current.state).toBe("prompt");
    return rendered;
  }

  it("triggers the warm job, polls, and calls onProceed once mapped", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // requestSubmit check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // poll 1: still a miss
      .mockResolvedValueOnce({ mapped: true, checkable: true }); // poll 2: hit
    const onProceed = vi.fn();
    const { result } = await toPrompt(onProceed);

    await act(async () => result.current.startWaiting());
    expect(result.current.state).toBe("waiting");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/repos/map-status", expect.objectContaining({ method: "POST" }));

    await advance(2500);
    expect(result.current.state).toBe("waiting");
    expect(onProceed).not.toHaveBeenCalled();

    await advance(2500);
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
  });

  // Regression test for the double-submit bug: overlapping poll ticks both resolving `mapped:
  // true` must still submit the form exactly once.
  it("calls onProceed once even when poll ticks overlap on a hit", async () => {
    let resolvePoll: ((value: unknown) => void) | undefined;
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // requestSubmit check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      // First poll hangs until we resolve it by hand, so a second tick fires meanwhile.
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePoll = resolve)))
      .mockResolvedValue({ mapped: true, checkable: true });
    const onProceed = vi.fn();
    const { result } = await toPrompt(onProceed);

    await act(async () => result.current.startWaiting());
    await advance(2500); // tick 1 -> hangs
    await advance(2500); // tick 2 -> skipped, previous request still in flight

    await act(async () => {
      resolvePoll?.({ mapped: true, checkable: true });
      await vi.advanceTimersByTimeAsync(2500);
    });
    await advance(2500);

    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
  });

  // Regression test for stale in-flight work: a poll started for the previous codebase must not
  // submit the form now that a different repo is selected.
  it("resets and ignores an in-flight poll when the codebase changes", async () => {
    let resolvePoll: ((value: unknown) => void) | undefined;
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // requestSubmit check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      .mockImplementationOnce(() => new Promise((resolve) => (resolvePoll = resolve)));
    const onProceed = vi.fn();
    const { result, rerender } = renderHook(({ codebase }) => useRepoMapWaitGate(codebase, onProceed), {
      initialProps: { codebase: "acme/widgets" },
    });
    act(() => result.current.requestSubmit());
    await flush();
    await act(async () => result.current.startWaiting());
    await advance(2500); // poll for acme/widgets is now in flight

    rerender({ codebase: "acme/other" });
    expect(result.current.state).toBe("hidden");

    await act(async () => {
      resolvePoll?.({ mapped: true, checkable: true });
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(onProceed).not.toHaveBeenCalled();
    expect(result.current.state).toBe("hidden");
  });

  it("shows the enqueue-failed message before proceeding", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // requestSubmit check
      .mockRejectedValueOnce(new Error("redis down")) // POST trigger warm fails
      .mockResolvedValue({ mapped: false, checkable: true }); // any straggler poll
    const onProceed = vi.fn();
    const { result } = await toPrompt(onProceed);

    await act(async () => result.current.startWaiting());
    await flush();

    // The message is actually on screen (state stays "waiting") before anything submits.
    expect(result.current.state).toBe("waiting");
    expect(result.current.fallbackMessage).toBe("enqueue-failed");
    expect(onProceed).not.toHaveBeenCalled();

    await advance(2500);
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
  });

  it("treats repeated poll failures as the fallback path", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // requestSubmit check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      .mockRejectedValueOnce(new Error("network")) // poll 1
      .mockRejectedValueOnce(new Error("network")) // poll 2
      .mockRejectedValueOnce(new Error("network")); // poll 3 -> give up
    const onProceed = vi.fn();
    const { result } = await toPrompt(onProceed);

    await act(async () => result.current.startWaiting());
    for (let i = 0; i < 3; i++) await advance(2500);

    expect(result.current.state).toBe("waiting");
    expect(result.current.fallbackMessage).toBe("poll-failed");
    expect(onProceed).not.toHaveBeenCalled();

    await advance(2500);
    expect(onProceed).toHaveBeenCalledOnce();
  });

  it("treats repeated uncheckable poll results the same as failures", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // requestSubmit check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      .mockResolvedValue({ mapped: false, checkable: false }); // every poll: can't determine
    const onProceed = vi.fn();
    const { result } = await toPrompt(onProceed);

    await act(async () => result.current.startWaiting());
    for (let i = 0; i < 3; i++) await advance(2500);

    expect(result.current.fallbackMessage).toBe("poll-failed");
    expect(result.current.state).toBe("waiting");
    expect(onProceed).not.toHaveBeenCalled();

    await advance(2500);
    expect(onProceed).toHaveBeenCalledOnce();
  });

  it("lets the escape hatch proceed immediately while a fallback message is showing", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // requestSubmit check
      .mockRejectedValueOnce(new Error("redis down")) // POST trigger warm fails
      .mockResolvedValue({ mapped: false, checkable: true });
    const onProceed = vi.fn();
    const { result } = await toPrompt(onProceed);

    await act(async () => result.current.startWaiting());
    await flush();
    expect(result.current.fallbackMessage).toBe("enqueue-failed");

    act(() => result.current.startNow());
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");

    // The pending fallback timer was cancelled, so it can't submit a second time.
    await advance(5000);
    expect(onProceed).toHaveBeenCalledOnce();
  });
});
