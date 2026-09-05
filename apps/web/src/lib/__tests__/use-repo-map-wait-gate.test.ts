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

it("stays hidden when there is no codebase", () => {
  const { result } = renderHook(() => useRepoMapWaitGate("", vi.fn()));
  expect(result.current.state).toBe("hidden");
  expect(apiFetchMock).not.toHaveBeenCalled();
});

it("goes hidden after a checkable, mapped result", async () => {
  apiFetchMock.mockResolvedValue({ mapped: true, checkable: true });
  const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
  expect(result.current.state).toBe("checking");
  await flush();
  expect(result.current.state).toBe("hidden");
  expect(apiFetchMock).toHaveBeenCalledWith("/api/repos/map-status?codebase=acme%2Fwidgets");
});

it("goes hidden when the initial check isn't checkable", async () => {
  apiFetchMock.mockResolvedValue({ mapped: false, checkable: false });
  const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
  await flush();
  expect(result.current.state).toBe("hidden");
});

it("goes hidden when the initial check throws", async () => {
  apiFetchMock.mockRejectedValue(new Error("network error"));
  const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
  await flush();
  expect(result.current.state).toBe("hidden");
});

it("shows the prompt on a checkable miss", async () => {
  apiFetchMock.mockResolvedValue({ mapped: false, checkable: true });
  const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
  await flush();
  expect(result.current.state).toBe("prompt");
});

describe("startNow", () => {
  it("hides the banner and calls onProceed immediately", async () => {
    apiFetchMock.mockResolvedValue({ mapped: false, checkable: true });
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    await flush();
    expect(result.current.state).toBe("prompt");

    act(() => result.current.startNow());

    expect(result.current.state).toBe("hidden");
    expect(onProceed).toHaveBeenCalledOnce();
  });
});

describe("startWaiting", () => {
  it("triggers the warm job, polls, and calls onProceed once mapped", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // initial check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // poll 1: still miss
      .mockResolvedValueOnce({ mapped: true, checkable: true }); // poll 2: hit
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    await flush();
    expect(result.current.state).toBe("prompt");

    await act(async () => result.current.startWaiting());
    expect(result.current.state).toBe("waiting");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/repos/map-status",
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.state).toBe("waiting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
  });

  it("falls back to startNow when triggering the warm job fails", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // initial check
      .mockRejectedValueOnce(new Error("redis down")); // POST trigger warm fails
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    await flush();
    expect(result.current.state).toBe("prompt");

    await act(async () => result.current.startWaiting());
    await flush();
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
    expect(result.current.fallbackMessage).toBe("enqueue-failed");
  });

  it("falls back to startNow after repeated poll failures", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // initial check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      .mockRejectedValueOnce(new Error("network")) // poll 1
      .mockRejectedValueOnce(new Error("network")) // poll 2
      .mockRejectedValueOnce(new Error("network")); // poll 3 -> give up
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    await flush();
    expect(result.current.state).toBe("prompt");

    await act(async () => result.current.startWaiting());
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
    }
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.fallbackMessage).toBe("poll-failed");
  });
});
