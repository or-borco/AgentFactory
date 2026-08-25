// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { RunContextPanel } from "../RunContextPanel";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const RUNS: Run[] = [{ id: 7, sessionId: 1, status: "done", costUsd: 0, tokensUsed: 0, createdAt: "2026-08-26T10:00:00.000Z" } as Run];

const PROMPT = {
  runId: 7,
  promptHash: "c".repeat(64),
  segments: [
    { id: "platform_preamble", text: "You are an agent.\n" },
    { id: "team_context", text: "", omittedReason: "no_team" },
    { id: "agent_system_prompt", text: "You are a reviewer." },
  ],
};

function renderPanel(runs: Run[] = RUNS) {
  render(
    <I18nProvider>
      <RunContextPanel runs={runs} />
    </I18nProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

describe("RunContextPanel", () => {
  it("renders an empty state when the session has no runs", () => {
    renderPanel([]);
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("fetches the newest run's prompt once and lists each layer with its label", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Platform preamble")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/runs/7/prompt");
    expect(screen.getByText("Team context")).toBeInTheDocument();
    expect(screen.getByText("Agent system prompt")).toBeInTheDocument();
  });

  // The reason an omitted layer exists at all — "empty" and "why it's empty" are different bugs.
  it("shows the specific omission reason for a layer that contributed nothing", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Not included: agent has no team")).toBeInTheDocument());
  });

  it("expands a layer to reveal its exact text", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Platform preamble")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Platform preamble"));
    expect(screen.getByText("You are an agent.")).toBeInTheDocument();
  });

  it("shows the joined prompt and hash in the raw view", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("View raw prompt")).toBeInTheDocument());
    fireEvent.click(screen.getByText("View raw prompt"));
    // The joined text spans a newline inside a single <pre>; match on raw textContent
    // rather than getByText's whitespace-collapsing normalizer.
    expect(
      screen.getByText((_, element) => element?.textContent === "You are an agent.\nYou are a reviewer."),
    ).toBeInTheDocument();
    expect(screen.getByText(`Prompt hash: ${"c".repeat(64)}`)).toBeInTheDocument();
  });

  it("states plainly when a run never recorded a prompt", async () => {
    apiFetchMock.mockResolvedValue({ segments: null });
    renderPanel();

    await waitFor(() =>
      expect(
        screen.getByText("No prompt was recorded for this run — it failed before composing one."),
      ).toBeInTheDocument(),
    );
  });

  it("surfaces a load failure instead of rendering an empty prompt", async () => {
    // mockRejectedValueOnce (rather than the persistent mockRejectedValue) avoids a Vitest
    // quirk where a still-configured rejection handler leaks an unhandled-rejection warning
    // into this test; the panel only ever calls apiFetch once per run regardless.
    apiFetchMock.mockRejectedValueOnce(new Error("boom"));
    renderPanel();

    await waitFor(() => expect(screen.getByText("Couldn't load this run's prompt. Try again.")).toBeInTheDocument());
  });
});
