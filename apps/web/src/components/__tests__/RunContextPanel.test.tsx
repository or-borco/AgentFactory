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

const NO_PROMPT_COPY =
  "No prompt was recorded for this run. Runs that fail before composing a prompt, and runs from before this feature shipped, have nothing to show here.";

const PROMPT = {
  runId: 7,
  promptHash: "c".repeat(64),
  segments: [
    { id: "platform_preamble", text: "You are an agent.\n" },
    { id: "team_context", text: "", omittedReason: "no_team" },
    { id: "agent_system_prompt", text: "You are a reviewer." },
  ],
};

// A run whose team had indexed documents: the retrieved layer contributed real text.
const RETRIEVAL_PROMPT = {
  runId: 7,
  promptHash: "d".repeat(64),
  segments: [
    { id: "repo_map", text: "", omittedReason: "no_codebase" },
    {
      id: "retrieved_context",
      text: "## Retrieved Context\n\nRotate service credentials once per quarter.\n",
    },
    { id: "team_context", text: "Ship small PRs.\n" },
  ],
};

// Path-aware because a prompt carrying a retrieved layer makes the panel issue a second
// request; the prompt-only tests above keep using mockResolvedValue.
function mockApi(prompt: unknown, retrievals: unknown = []) {
  apiFetchMock.mockImplementation((path: string) =>
    String(path).endsWith("/retrievals") ? Promise.resolve(retrievals) : Promise.resolve(prompt),
  );
}

function renderPanel(runs: Run[] = RUNS) {
  return render(
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

  // Regression: the Context tab is gated only on the session existing, so a user can open it
  // before the page's own runs fetch resolves — the panel then mounts with runs=[] and must
  // recover once runs arrives, rather than freezing on an empty-at-mount selection.
  it("starts loading a run's prompt once the runs list arrives after mount", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    const { rerender } = renderPanel([]);

    expect(screen.getByText("No runs yet")).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();

    rerender(
      <I18nProvider>
        <RunContextPanel runs={RUNS} />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("Platform preamble")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/runs/7/prompt");
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

  it("states plainly when a terminal run never recorded a prompt, and asks only once", async () => {
    apiFetchMock.mockResolvedValue({ segments: null });
    const { rerender } = renderPanel();

    await waitFor(() => expect(screen.getByText(NO_PROMPT_COPY)).toBeInTheDocument());

    // A finished run that has no segments never will have any, so a re-render (the task page
    // re-renders this panel on every ~1.5s poll tick) must not re-ask.
    rerender(
      <I18nProvider>
        <RunContextPanel runs={RUNS} />
      </I18nProvider>,
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
  });

  // Regression: a run that is still in flight hasn't had its segments written yet (the worker
  // writes them in the same statement that flips the status to `running`). Caching that null as
  // "never recorded" left a healthy run permanently claiming it had no prompt.
  it("re-asks for a still-running run's prompt once its status advances", async () => {
    const queuedRun = [{ ...RUNS[0], status: "queued" } as Run];
    apiFetchMock.mockResolvedValueOnce({ segments: null });
    const { rerender } = renderPanel(queuedRun);

    await waitFor(() => expect(screen.getByText(NO_PROMPT_COPY)).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    apiFetchMock.mockResolvedValueOnce(PROMPT);
    rerender(
      <I18nProvider>
        <RunContextPanel runs={[{ ...RUNS[0], status: "running" } as Run]} />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText("Platform preamble")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(NO_PROMPT_COPY)).not.toBeInTheDocument();
  });

  it("surfaces a load failure instead of rendering an empty prompt", async () => {
    // One rejection is all the panel can consume — it fetches once per run.
    apiFetchMock.mockRejectedValueOnce(new Error("boom"));
    renderPanel();

    await waitFor(() => expect(screen.getByText(/Couldn't load this run's prompt/)).toBeInTheDocument());
  });

  it("retries the fetch when the user clicks Try again after a failure", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("boom"));
    renderPanel();

    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument());

    apiFetchMock.mockResolvedValueOnce(PROMPT);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.getByText("Platform preamble")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("renders an omitted layer as a plain row, not a disabled button", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Team context")).toBeInTheDocument());
    // The expandable layers are buttons; the omitted one must not be (a disabled button leaves
    // the tab order and is announced inconsistently).
    expect(screen.queryByRole("button", { name: /Team context/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Platform preamble/ })).toBeInTheDocument();
  });
});

describe("RunContextPanel — the retrieved-documents layer", () => {
  it("names the retrieved layer instead of falling back to the generic label", async () => {
    mockApi(RETRIEVAL_PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Retrieved documents")).toBeInTheDocument());
    expect(screen.queryByText("Additional context")).not.toBeInTheDocument();
  });

  it("says the team has no indexed documents when that is why the layer is empty", async () => {
    mockApi({
      runId: 7,
      promptHash: "d".repeat(64),
      segments: [{ id: "retrieved_context", text: "", omittedReason: "no_indexed_documents" }],
    });
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText("Not included: this team has no indexed documents")).toBeInTheDocument(),
    );
  });

  it("distinguishes an empty search from a broken one", async () => {
    mockApi({
      runId: 7,
      promptHash: "d".repeat(64),
      segments: [
        { id: "retrieved_context", text: "", omittedReason: "no_relevant_chunks" },
        { id: "team_context", text: "", omittedReason: "retrieval_failed" },
      ],
    });
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText("Not included: no document excerpt matched this task")).toBeInTheDocument(),
    );
    expect(screen.getByText("Not included: document retrieval failed for this run")).toBeInTheDocument();
  });
});
