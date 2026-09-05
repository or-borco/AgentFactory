// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
