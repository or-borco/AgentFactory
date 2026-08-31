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
// of the fraction. This is NOT the same state as a context with nothing checkable in it: the
// judge did extract an instruction, it just never governed this run. The headline has to say
// so rather than render "0 of 0" or claim the context was empty.
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

// One pass and four "unclear" — the ordinary case of a broad team context whose rules have
// nothing to say about this artefact. The headline denominator counts only what scored, so it
// reads "1 of 1"; without a separate line the card would show a clean sweep for a run where
// four of five instructions were never checked at all.
const MOSTLY_UNCLEAR_EVAL: RunEval = {
  id: 34,
  orgId: 1,
  runId: 7,
  status: "done",
  judgeModelId: "claude-sonnet-5",
  createdAt: "2026-08-26T14:00:00.000Z",
  completedAt: "2026-08-26T14:00:20.000Z",
  result: {
    artefactKind: "final_message",
    score: 1,
    layers: [
      {
        segmentId: "team_context",
        requirements: [
          { text: "Write in past tense", verdict: "pass", evidence: "Added support for…" },
          { text: "No raw SQL", verdict: "unclear", evidence: "The reply contains no code" },
          { text: "Use conventional commits", verdict: "unclear", evidence: "Nothing was committed" },
          { text: "Update the changelog", verdict: "unclear", evidence: "Nothing was committed" },
          { text: "Add tests for new code", verdict: "unclear", evidence: "Nothing was committed" },
        ],
      },
    ],
  },
};

// Both disclosure lines at once: one instruction the user's request set aside, one the
// artefact could not answer for. Neither is on either side of the fraction, and neither may
// hide the other.
const MIXED_ASIDE_EVAL: RunEval = {
  id: 35,
  orgId: 1,
  runId: 7,
  status: "done",
  judgeModelId: "claude-sonnet-5",
  createdAt: "2026-08-26T15:00:00.000Z",
  completedAt: "2026-08-26T15:00:20.000Z",
  result: {
    artefactKind: "final_message",
    score: 1,
    layers: [
      {
        segmentId: "agent_system_prompt",
        requirements: [
          { text: "Write in past tense", verdict: "pass", evidence: "Added support for…" },
          { text: "Summarize merged PRs since the last tag", verdict: "overridden", evidence: '"the last 5 PRs"' },
          { text: "Update the changelog", verdict: "unclear", evidence: "Nothing was committed" },
        ],
      },
    ],
  },
};

function makeEval(overrides: Partial<RunEval>): RunEval {
  return {
    id: 31,
    orgId: 1,
    runId: 7,
    status: "done",
    judgeModelId: "claude-sonnet-5",
    createdAt: "2026-08-26T11:00:00.000Z",
    completedAt: "2026-08-26T11:00:20.000Z",
    ...overrides,
    result: {
      artefactKind: "diff",
      score: 0.5,
      layers: [],
      ...overrides.result,
    },
  } as RunEval;
}

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

  // The denominator must keep matching the stored score, so unclear requirements stay out of
  // it — but a headline of "1 of 1" over four unchecked instructions reads as a clean sweep.
  it("says how many instructions could not be checked, without touching the denominator", async () => {
    apiFetchMock.mockResolvedValueOnce([MOSTLY_UNCLEAR_EVAL]);
    renderPanel();
    expect(await screen.findByText("1 of 1 instructions followed")).toBeInTheDocument();
    expect(screen.getByText("4 could not be checked against this run")).toBeInTheDocument();
  });

  it("shows no unchecked line when every instruction was actually checked", async () => {
    apiFetchMock.mockResolvedValueOnce([DONE_EVAL]);
    renderPanel();
    await screen.findByText("1 of 2 instructions followed");
    expect(screen.queryByText(/could not be checked/)).not.toBeInTheDocument();
  });

  it("shows the unchecked count and the override count together", async () => {
    apiFetchMock.mockResolvedValueOnce([MIXED_ASIDE_EVAL]);
    renderPanel();
    expect(await screen.findByText("1 of 1 instructions followed")).toBeInTheDocument();
    expect(screen.getByText("1 overridden by the user's request")).toBeInTheDocument();
    expect(screen.getByText("1 could not be checked against this run")).toBeInTheDocument();
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

  it("separates 'nothing scored' from 'nothing checkable' when every requirement was overridden", async () => {
    apiFetchMock.mockResolvedValueOnce([ALL_OVERRIDDEN_EVAL]);
    renderPanel();
    expect(
      await screen.findByText("None of the 1 instructions could be scored on this run."),
    ).toBeInTheDocument();
    // The empty-context copy would be a false statement here: the judge found an instruction.
    expect(screen.queryByText(/no checkable instructions/)).not.toBeInTheDocument();
    // The overridden note still names the one instruction that was set aside — it just no
    // longer leaves a "0 of 0" headline sitting above it.
    expect(screen.getByText("1 overridden by the user's request")).toBeInTheDocument();
    expect(screen.queryByText(/instructions followed/)).not.toBeInTheDocument();
  });

  it("keeps the empty-context copy for an eval whose judge extracted no requirements at all", async () => {
    apiFetchMock.mockResolvedValueOnce([
      { ...ALL_OVERRIDDEN_EVAL, result: { artefactKind: "final_message", score: 0, layers: [] } },
    ]);
    renderPanel();
    expect(await screen.findByText(/no checkable instructions/)).toBeInTheDocument();
    expect(screen.queryByText(/could be scored/)).not.toBeInTheDocument();
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

  it("reports retrieval precision alongside the instruction score", async () => {
    apiFetchMock.mockResolvedValueOnce([
      makeEval({
        result: {
          artefactKind: "diff",
          layers: [],
          score: 1,
          retrieval: {
            precision: 2 / 3,
            chunks: [
              { itemTitle: "Auth handbook", chunkIdx: 2, relevant: true, reason: "Covers session expiry." },
              { itemTitle: "Runbooks", chunkIdx: 0, relevant: false, reason: "Unrelated to the request." },
              { itemTitle: "Auth handbook", chunkIdx: 3, relevant: true, reason: "Covers the refresh path." },
            ],
          },
        },
      }),
    ]);

    renderPanel();

    expect(await screen.findByText("2 of 3 retrieved excerpts were relevant")).toBeInTheDocument();
  });

  it("says so when excerpts were retrieved and none were relevant", async () => {
    apiFetchMock.mockResolvedValueOnce([
      makeEval({
        result: {
          artefactKind: "diff",
          layers: [],
          score: 1,
          retrieval: {
            precision: 0,
            chunks: [{ itemTitle: "Runbooks", chunkIdx: 0, relevant: false, reason: "Unrelated." }],
          },
        },
      }),
    ]);

    renderPanel();

    expect(await screen.findByText("0 of 1 retrieved excerpts were relevant")).toBeInTheDocument();
  });

  // The absent field means "no retrieved layer on this run" — every eval stored before this
  // shipped, and every run for a team with no documents. It must render nothing at all.
  it("says nothing about retrieval when the run had no retrieved layer", async () => {
    apiFetchMock.mockResolvedValueOnce([makeEval({ result: { artefactKind: "diff", layers: [], score: 1 } })]);

    renderPanel();

    await screen.findByText(/no checkable/);
    expect(screen.queryByText(/retrieved excerpts/)).not.toBeInTheDocument();
  });

  // Every eval but the newest renders collapsed (index > 0). The retrieval line must fold away
  // with the rest of the card's detail, like the instruction headline beside it — not float on
  // its own next to a collapsed card's bare timestamp.
  it("hides the retrieval line on a collapsed (non-newest) eval card", async () => {
    apiFetchMock.mockResolvedValueOnce([
      makeEval({
        id: 31,
        createdAt: "2026-08-26T12:00:00.000Z",
        result: { artefactKind: "diff", layers: [], score: 1 },
      }),
      makeEval({
        id: 32,
        createdAt: "2026-08-26T11:00:00.000Z",
        result: {
          artefactKind: "diff",
          layers: [],
          score: 1,
          retrieval: {
            precision: 1,
            chunks: [{ itemTitle: "Auth handbook", chunkIdx: 2, relevant: true, reason: "Covers session expiry." }],
          },
        },
      }),
    ]);

    renderPanel();

    await screen.findByText(/no checkable/);
    expect(screen.queryByText("1 of 1 retrieved excerpts were relevant")).not.toBeInTheDocument();
  });

  // chunkIdx is the judge's own report of an excerpt's ordinal — even with the "[Excerpt N]"
  // markers context-retrieval.ts now sends it something real to read, a judge that still
  // misreports it can repeat an (itemTitle, chunkIdx) pair. The irrelevant-chunk list keys on
  // the array index instead, so a repeated pair must render both lines without React logging a
  // duplicate-key warning.
  it("renders two irrelevant chunks with the same itemTitle and chunkIdx without a duplicate-key warning", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    apiFetchMock.mockResolvedValueOnce([
      makeEval({
        result: {
          artefactKind: "diff",
          layers: [],
          score: 1,
          retrieval: {
            precision: 0,
            chunks: [
              { itemTitle: "Runbooks", chunkIdx: 0, relevant: false, reason: "First unrelated excerpt." },
              { itemTitle: "Runbooks", chunkIdx: 0, relevant: false, reason: "Second unrelated excerpt." },
            ],
          },
        },
      }),
    ]);

    renderPanel();

    expect(await screen.findByText("Not relevant: Runbooks — chunk 0 · First unrelated excerpt.")).toBeInTheDocument();
    expect(screen.getByText("Not relevant: Runbooks — chunk 0 · Second unrelated excerpt.")).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("same key"), expect.anything());
    consoleError.mockRestore();
  });
});
