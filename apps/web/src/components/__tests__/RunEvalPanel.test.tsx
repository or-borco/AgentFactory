// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunEval } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { RunEvalPanel } from "../RunEvalPanel";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const DONE_RUN: Run[] = [
  { id: 7, sessionId: 1, status: "done", costUsd: 0, tokensUsed: 0, promptHash: "c".repeat(64), createdAt: "2026-08-26T10:00:00.000Z" } as Run,
];
const RUNNING_RUN: Run[] = [
  { id: 8, sessionId: 1, status: "running", costUsd: 0, tokensUsed: 0, createdAt: "2026-08-26T10:00:00.000Z" } as Run,
];
// Terminal, but the run never got a promptHash recorded (e.g. it failed before composing a
// prompt) — the second of the two disabled-reason branches.
const NO_PROMPT_RUN: Run[] = [
  { id: 9, sessionId: 1, status: "done", costUsd: 0, tokensUsed: 0, createdAt: "2026-08-26T10:00:00.000Z" } as Run,
];

const DONE_EVAL: RunEval = {
  id: 31,
  orgId: 1,
  runId: 7,
  status: "done",
  judgeModelId: "claude-sonnet-5",
  createdAt: "2026-08-26T11:00:00.000Z",
  completedAt: "2026-08-26T11:00:20.000Z",
  result: {
    artefactKind: "diff",
    score: 0.5,
    layers: [
      {
        segmentId: "team_context",
        requirements: [
          { text: "Use conventional commits", verdict: "pass", evidence: "feat: add parser" },
          { text: "Update the changelog", verdict: "fail", evidence: "No CHANGELOG edit in the diff" },
        ],
      },
    ],
  },
};

// An "overridden" requirement — the agent set an instruction aside because the user's own
// request contradicted it. It is neither a pass nor a fail, and the card has to say so
// without expanding a layer, which is what the summary count is for.
const OVERRIDDEN_EVAL: RunEval = {
  id: 32,
  orgId: 1,
  runId: 7,
  status: "done",
  judgeModelId: "claude-sonnet-5",
  createdAt: "2026-08-26T12:00:00.000Z",
  completedAt: "2026-08-26T12:00:20.000Z",
  result: {
    artefactKind: "final_message",
    score: 1,
    layers: [
      {
        segmentId: "agent_system_prompt",
        requirements: [
          { text: "Summarize merged PRs since the last tag", verdict: "overridden", evidence: '"the last 5 PRs"' },
          { text: "Write in past tense", verdict: "pass", evidence: "Added support for…" },
        ],
      },
    ],
  },
};

// Every requirement was overridden by the user's own request — nothing scored on either side
// of the fraction, so the headline must fall back to the same "nothing to grade" copy as the
// zero-layers case rather than render "0 of 0 instructions followed".
const ALL_OVERRIDDEN_EVAL: RunEval = {
  id: 33,
  orgId: 1,
  runId: 7,
  status: "done",
  judgeModelId: "claude-sonnet-5",
  createdAt: "2026-08-26T13:00:00.000Z",
  completedAt: "2026-08-26T13:00:20.000Z",
  result: {
    artefactKind: "final_message",
    score: 1,
    layers: [
      {
        segmentId: "agent_system_prompt",
        requirements: [
          { text: "Summarize merged PRs since the last tag", verdict: "overridden", evidence: '"the last 5 PRs"' },
        ],
      },
    ],
  },
};

function renderPanel(runs: Run[] = DONE_RUN) {
  return render(
    <I18nProvider>
      <RunEvalPanel runs={runs} />
    </I18nProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

describe("RunEvalPanel", () => {
  it("renders an empty state when the session has no runs", () => {
    renderPanel([]);
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });

  it("shows the intro and an enabled Evaluate button for a finished run with no evals", async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    renderPanel();
    expect(await screen.findByRole("button", { name: "Evaluate" })).toBeEnabled();
    expect(screen.getByText(/Score this run's deliverable/)).toBeInTheDocument();
  });

  it("disables the button with a reason while the run is still active", async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    renderPanel(RUNNING_RUN);
    expect(await screen.findByRole("button", { name: "Evaluate" })).toBeDisabled();
    expect(screen.getByText("Available once the run finishes")).toBeInTheDocument();
  });

  it("shows the running treatment for a queued eval", async () => {
    apiFetchMock.mockResolvedValue([{ ...DONE_EVAL, status: "queued", result: undefined, completedAt: undefined }]);
    renderPanel();
    expect(await screen.findByText("Evaluating…")).toBeInTheDocument();
  });

  it("renders a done card: headline, artefact, verdicts, evidence, judge stamp", async () => {
    apiFetchMock.mockResolvedValueOnce([DONE_EVAL]);
    renderPanel();
    expect(await screen.findByText("1 of 2 instructions followed")).toBeInTheDocument();
    expect(screen.getByText("Graded the code this run committed")).toBeInTheDocument();
    expect(screen.getByText("Use conventional commits")).toBeInTheDocument();
    expect(screen.getByText("Not followed")).toBeInTheDocument();
    expect(screen.getByText(/No CHANGELOG edit in the diff/)).toBeInTheDocument();
    expect(screen.getByText("Judged by claude-sonnet-5")).toBeInTheDocument();
  });

  it("labels an overridden requirement and shows its evidence quote", async () => {
    apiFetchMock.mockResolvedValueOnce([OVERRIDDEN_EVAL]);
    renderPanel();
    expect(await screen.findByText("Summarize merged PRs since the last tag")).toBeInTheDocument();
    expect(screen.getByText("Overridden by request")).toBeInTheDocument();
    expect(screen.getByText(/the last 5 PRs/)).toBeInTheDocument();
  });

  it("counts overrides on the card, and shows no count when there are none", async () => {
    apiFetchMock.mockResolvedValueOnce([OVERRIDDEN_EVAL]);
    const { unmount } = renderPanel();
    expect(await screen.findByText("1 overridden by the user's request")).toBeInTheDocument();
    // The overridden requirement is excluded from the headline's denominator, so it doesn't
    // count against the run — only the one requirement that actually scored (the pass) does.
    expect(screen.getByText("1 of 1 instructions followed")).toBeInTheDocument();
    unmount();

    apiFetchMock.mockResolvedValueOnce([DONE_EVAL]);
    renderPanel();
    await screen.findByText("1 of 2 instructions followed");
    expect(screen.queryByText(/overridden by the user's request/)).not.toBeInTheDocument();
  });

  it("shows a truncation notice when the artefact was cut for size before grading", async () => {
    apiFetchMock.mockResolvedValueOnce([
      { ...DONE_EVAL, result: { ...DONE_EVAL.result!, truncated: true } },
    ]);
    renderPanel();
    expect(await screen.findByText(/too large/i)).toBeInTheDocument();
  });

  it("shows no truncation notice when the artefact was graded whole", async () => {
    apiFetchMock.mockResolvedValueOnce([DONE_EVAL]);
    renderPanel();
    await screen.findByText("1 of 2 instructions followed");
    expect(screen.queryByText(/too large/i)).not.toBeInTheDocument();
  });

  it("states plainly when nothing was checkable", async () => {
    apiFetchMock.mockResolvedValueOnce([
      { ...DONE_EVAL, result: { artefactKind: "final_message", score: 0, layers: [] } },
    ]);
    renderPanel();
    expect(await screen.findByText(/no checkable instructions/)).toBeInTheDocument();
  });

  it("states plainly when nothing was checkable because every requirement was overridden", async () => {
    apiFetchMock.mockResolvedValueOnce([ALL_OVERRIDDEN_EVAL]);
    renderPanel();
    expect(await screen.findByText(/no checkable instructions/)).toBeInTheDocument();
    // The overridden note still names the one instruction that was set aside — it just no
    // longer leaves a "0 of 0" headline sitting above it.
    expect(screen.getByText("1 overridden by the user's request")).toBeInTheDocument();
    expect(screen.queryByText(/instructions followed/)).not.toBeInTheDocument();
  });

  it("renders a failed card with the mapped reason and the button again", async () => {
    apiFetchMock.mockResolvedValueOnce([
      { ...DONE_EVAL, status: "failed", result: undefined, error: "artefact_unavailable" },
    ]);
    renderPanel();
    expect(await screen.findByText(/could not be fetched/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Evaluate again" })).toBeEnabled();
  });

  it("lists older evals under a history heading, newest card first", async () => {
    const older: RunEval = { ...DONE_EVAL, id: 30, createdAt: "2026-08-26T09:00:00.000Z" };
    apiFetchMock.mockResolvedValueOnce([DONE_EVAL, older]);
    renderPanel();
    expect(await screen.findByText("Previous evaluations")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 instructions followed")).toBeInTheDocument();
  });

  it("POSTs a new eval and refreshes the list when Evaluate is clicked", async () => {
    apiFetchMock.mockResolvedValueOnce([]); // initial GET
    renderPanel();
    const button = await screen.findByRole("button", { name: "Evaluate" });

    apiFetchMock.mockResolvedValueOnce({ ...DONE_EVAL, status: "queued", result: undefined }); // POST
    apiFetchMock.mockResolvedValue([{ ...DONE_EVAL, status: "queued", result: undefined }]); // refresh GET
    fireEvent.click(button);

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/runs/7/evals", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByText("Evaluating…")).toBeInTheDocument();
  });

  it("disables the button with a reason when the run has no recorded prompt", async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    renderPanel(NO_PROMPT_RUN);
    expect(await screen.findByRole("button", { name: "Evaluate" })).toBeDisabled();
    expect(screen.getByText("This run has no recorded prompt to grade against")).toBeInTheDocument();
  });

  it("keeps loaded history when a create attempt fails, and surfaces the failure locally", async () => {
    apiFetchMock.mockResolvedValueOnce([DONE_EVAL]); // initial GET
    renderPanel();
    const button = await screen.findByRole("button", { name: "Evaluate again" });
    expect(screen.getByText("1 of 2 instructions followed")).toBeInTheDocument();

    apiFetchMock.mockRejectedValueOnce(new Error("Run is not finished"));
    fireEvent.click(button);

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/runs/7/evals", expect.objectContaining({ method: "POST" })),
    );

    // The already-loaded card must survive a failed create — it must not be replaced by the
    // generic "couldn't load" view, which reads from the same evalsByRun state.
    expect(screen.getByText("1 of 2 instructions followed")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load evaluations for this run.")).not.toBeInTheDocument();
    // The failure is surfaced locally, near the button, using existing eval copy.
    expect(await screen.findByText("The judge call failed. Try again.")).toBeInTheDocument();
  });

  it("stops polling once a queued eval reaches a terminal status", async () => {
    vi.useFakeTimers();
    try {
      const queued = { ...DONE_EVAL, status: "queued" as const, result: undefined, completedAt: undefined };
      apiFetchMock.mockResolvedValueOnce([queued]); // initial GET on mount

      renderPanel();

      // Flush the mount-time fetch effect.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Evaluating…")).toBeInTheDocument();
      expect(apiFetchMock).toHaveBeenCalledTimes(1);

      // One poll tick fires and the eval flips to done.
      apiFetchMock.mockResolvedValueOnce([{ ...DONE_EVAL, status: "done" as const }]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByText("1 of 2 instructions followed")).toBeInTheDocument();

      // Further ticks must NOT issue another GET — this is the assertion that would catch a
      // poll that never stops once its eval reaches a terminal status.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000 * 5);
      });
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
