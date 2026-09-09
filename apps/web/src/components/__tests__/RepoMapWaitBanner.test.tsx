// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { RepoMapWaitBanner } from "../RepoMapWaitBanner";
import type { RepoMapWaitGate } from "../../lib/use-repo-map-wait-gate";

function gate(overrides: Partial<RepoMapWaitGate>): RepoMapWaitGate {
  return {
    state: "hidden",
    fallbackMessage: null,
    requestSubmit: vi.fn(),
    startWaiting: vi.fn(),
    startNow: vi.fn(),
    ...overrides,
  };
}

function renderBanner(g: RepoMapWaitGate) {
  return render(
    <I18nProvider>
      <RepoMapWaitBanner gate={g} />
    </I18nProvider>,
  );
}

describe("RepoMapWaitBanner", () => {
  it("renders nothing when hidden", () => {
    const { container } = renderBanner(gate({ state: "hidden" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while checking", () => {
    const { container } = renderBanner(gate({ state: "checking" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the prompt with both choices on a miss", () => {
    renderBanner(gate({ state: "prompt" }));
    expect(screen.getByText("This repo hasn't been mapped yet")).toBeInTheDocument();
    expect(screen.getByText("Start mapping")).toBeInTheDocument();
    expect(screen.getByText("Start now without it")).toBeInTheDocument();
  });

  it("calls startWaiting when the wait button is clicked", () => {
    const startWaiting = vi.fn();
    renderBanner(gate({ state: "prompt", startWaiting }));
    fireEvent.click(screen.getByText("Start mapping"));
    expect(startWaiting).toHaveBeenCalledOnce();
  });

  it("calls startNow when the start-now button is clicked", () => {
    const startNow = vi.fn();
    renderBanner(gate({ state: "prompt", startNow }));
    fireEvent.click(screen.getByText("Start now without it"));
    expect(startNow).toHaveBeenCalledOnce();
  });

  it("shows the waiting state with the escape hatch", () => {
    renderBanner(gate({ state: "waiting" }));
    expect(screen.getByText("Preparing repo context…")).toBeInTheDocument();
    expect(screen.getByText("Never mind, start without it")).toBeInTheDocument();
  });

  it("shows the fallback message instead of the default waiting copy when set", () => {
    renderBanner(gate({ state: "waiting", fallbackMessage: "poll-failed" }));
    expect(screen.getByText("Couldn't check on the map — continuing without it.")).toBeInTheDocument();
  });

  it("calls startNow from the escape hatch", () => {
    const startNow = vi.fn();
    renderBanner(gate({ state: "waiting", startNow }));
    fireEvent.click(screen.getByText("Never mind, start without it"));
    expect(startNow).toHaveBeenCalledOnce();
  });

  describe("progress indicator", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows the setting-up phase immediately on entering waiting", () => {
      renderBanner(gate({ state: "waiting" }));
      expect(screen.getByText("Setting up…")).toBeInTheDocument();
    });

    it("transitions to the generating phase after 5s", () => {
      renderBanner(gate({ state: "waiting" }));
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByText("Generating the map…")).toBeInTheDocument();
    });

    it("transitions to the taking-longer phase after 30s and stays there", () => {
      renderBanner(gate({ state: "waiting" }));
      act(() => {
        vi.advanceTimersByTime(30000);
      });
      expect(screen.getByText("Still working — this one's taking a bit longer…")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(30000);
      });
      expect(screen.getByText("Still working — this one's taking a bit longer…")).toBeInTheDocument();
    });

    it("does not show the progress indicator when a fallback message is set", () => {
      renderBanner(gate({ state: "waiting", fallbackMessage: "poll-failed" }));
      expect(screen.queryByText("Setting up…")).not.toBeInTheDocument();
    });

    it("resets to the setting-up phase when re-entering waiting after leaving it", () => {
      const { rerender } = render(
        <I18nProvider>
          <RepoMapWaitBanner gate={gate({ state: "waiting" })} />
        </I18nProvider>,
      );
      act(() => {
        vi.advanceTimersByTime(30000);
      });
      expect(screen.getByText("Still working — this one's taking a bit longer…")).toBeInTheDocument();

      rerender(
        <I18nProvider>
          <RepoMapWaitBanner gate={gate({ state: "hidden" })} />
        </I18nProvider>,
      );
      rerender(
        <I18nProvider>
          <RepoMapWaitBanner gate={gate({ state: "waiting" })} />
        </I18nProvider>,
      );
      expect(screen.getByText("Setting up…")).toBeInTheDocument();
    });
  });
});
