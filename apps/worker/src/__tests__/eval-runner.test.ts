import { describe, expect, it, vi } from "vitest";
import type { PromptSegment, RunEval, RunEvalResult } from "@agentfactory/core";
import type { EvalRunnerDeps } from "../eval-runner";

// eval-runner.ts (directly, and transitively via eval-artefact.ts/scm-provider.ts) imports
// from "@agentfactory/db", whose client throws at import time if DATABASE_URL isn't set —
// true for the unit project, which runs with no database. This test drives processEvalJob
// entirely through the deps seam and never touches the real db module, so a lightweight
// mock (matching the pattern already used in eval-artefact.test.ts / scm-provider.test.ts)
// is enough to make the module graph loadable here.
vi.mock("@agentfactory/db", () => ({
  getRunEval: vi.fn(),
  getRun: vi.fn(),
  getRunPrompt: vi.fn(),
  getSession: vi.fn(),
  getTaskBySessionId: vi.fn(),
  markEvalRunning: vi.fn(),
  completeEval: vi.fn(),
  failEval: vi.fn(),
  getFinalAssistantMessageForRun: vi.fn(),
  getMessage: vi.fn(),
  listConnections: vi.fn(),
}));

const { ArtefactUnavailableError } = await import("../eval-artefact");
const { processEvalJob } = await import("../eval-runner");

const EVAL: RunEval = { id: 1, orgId: 2, runId: 7, status: "queued", createdAt: "2026-08-26T10:00:00.000Z" };
const SEGMENTS: PromptSegment[] = [
  { id: "platform_preamble", text: "You are an agent." },
  { id: "agent_system_prompt", text: "You are a reviewer." },
];
const RESULT: RunEvalResult = { artefactKind: "diff", layers: [], score: 0 };

function makeDeps(overrides: Partial<EvalRunnerDeps> = {}): EvalRunnerDeps {
  return {
    getRunEval: vi.fn().mockResolvedValue(EVAL),
    getRun: vi.fn().mockResolvedValue({ id: 7, sessionId: 12, status: "done", triggeringMessageId: 55 }),
    getRunPrompt: vi.fn().mockResolvedValue({ runId: 7, segments: SEGMENTS }),
    getSession: vi.fn().mockResolvedValue({ id: 12, orgId: 2, agentId: 3 }),
    getTaskBySessionId: vi.fn().mockResolvedValue({ id: 5, codebase: "acme/backend" }),
    getTriggeringMessage: vi.fn().mockResolvedValue({ content: "write the release notes for the last 5 PRs" }),
    markEvalRunning: vi.fn().mockResolvedValue(undefined),
    completeEval: vi.fn().mockResolvedValue(EVAL),
    failEval: vi.fn().mockResolvedValue(EVAL),
    resolveArtefact: vi.fn().mockResolvedValue({ kind: "diff", text: "+line" }),
    judge: vi.fn().mockResolvedValue({ result: RESULT, judgeModelId: "claude-sonnet-5" }),
    ...overrides,
  } as EvalRunnerDeps;
}

describe("processEvalJob", () => {
  it("marks running, judges the human segments against the artefact, and completes", async () => {
    const deps = makeDeps();
    await processEvalJob(1, deps);

    expect(deps.markEvalRunning).toHaveBeenCalledWith(1);
    // Only the human-authored layer reaches the judge — together with what the user actually
    // asked for, without which an agent that obeyed a narrower request reads as disobedient.
    expect(deps.judge).toHaveBeenCalledWith(
      [{ id: "agent_system_prompt", text: "You are a reviewer." }],
      { kind: "diff", text: "+line" },
      "write the release notes for the last 5 PRs",
    );
    expect(deps.getTriggeringMessage).toHaveBeenCalledWith(55);
    // The whole Run, not just its id: the artefact rule reads the run's recorded commit range
    // to decide what this run — as opposed to its siblings on the same branch — is graded on.
    expect(deps.resolveArtefact).toHaveBeenCalledWith(
      { id: 7, sessionId: 12, status: "done", triggeringMessageId: 55 },
      { id: 12, orgId: 2, agentId: 3 },
      { id: 5, codebase: "acme/backend" },
      2,
    );
    expect(deps.completeEval).toHaveBeenCalledWith(1, RESULT, "claude-sonnet-5");
    expect(deps.failEval).not.toHaveBeenCalled();
  });

  it("fails run_never_composed_prompt when the run has no stored segments", async () => {
    const deps = makeDeps({ getRunPrompt: vi.fn().mockResolvedValue(undefined) });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "run_never_composed_prompt");
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it("fails no_human_context when only platform layers were sent", async () => {
    const deps = makeDeps({
      getRunPrompt: vi.fn().mockResolvedValue({ runId: 7, segments: [SEGMENTS[0]] }),
    });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "no_human_context");
  });

  it("fails artefact_unavailable when the artefact cannot be resolved", async () => {
    const deps = makeDeps({
      resolveArtefact: vi.fn().mockRejectedValue(new ArtefactUnavailableError("branch diff fetch failed")),
    });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "artefact_unavailable");
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it("classifies an out-of-credits judge failure as insufficient_credit", async () => {
    const deps = makeDeps({
      judge: vi.fn().mockRejectedValue(new Error("Your credit balance is too low to access the Anthropic API")),
    });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "insufficient_credit");
  });

  it("classifies any other judge failure as judge_error", async () => {
    const deps = makeDeps({ judge: vi.fn().mockRejectedValue(new Error("overloaded")) });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "judge_error");
  });

  // BullMQ's stalled-job recovery can re-deliver a job after a worker crash. Re-running a
  // non-queued row would re-bill the judge call and walk an already-"done" row back through
  // "running" → "done" (or clobber a "failed" row's terminal reason). Only a fresh "queued"
  // row may proceed.
  it.each(["running", "done", "failed"] as const)(
    "skips the job without judging or writing anything when the row's status is already %s",
    async (status) => {
      const deps = makeDeps({ getRunEval: vi.fn().mockResolvedValue({ ...EVAL, status }) });
      await processEvalJob(1, deps);

      expect(deps.markEvalRunning).not.toHaveBeenCalled();
      expect(deps.judge).not.toHaveBeenCalled();
      expect(deps.completeEval).not.toHaveBeenCalled();
      expect(deps.failEval).not.toHaveBeenCalled();
    },
  );

  it("drops the job quietly when the eval row is gone", async () => {
    const deps = makeDeps({ getRunEval: vi.fn().mockResolvedValue(undefined) });
    await processEvalJob(1, deps);
    expect(deps.markEvalRunning).not.toHaveBeenCalled();
    expect(deps.failEval).not.toHaveBeenCalled();
  });

  // Once the eval row is loaded, every path must end as a terminal row and processEvalJob
  // must never reject — a thrown DB write here would leave the row stuck "running" forever
  // AND crash the BullMQ job handler.
  it("resolves (never rejects) and fails the row when the markEvalRunning write itself fails", async () => {
    const deps = makeDeps({ markEvalRunning: vi.fn().mockRejectedValue(new Error("connection refused")) });
    await expect(processEvalJob(1, deps)).resolves.toBeUndefined();
    expect(deps.failEval).toHaveBeenCalledWith(1, "judge_error");
  });

  // Pins classifyJudgeError's `String(err)` branch — a rejection that isn't an Error
  // instance (a bare string, as some providers/mocks throw) must still be classified.
  it("classifies a non-Error judge rejection via its stringified message", async () => {
    const deps = makeDeps({ judge: vi.fn().mockRejectedValue("credit balance is too low") });
    await expect(processEvalJob(1, deps)).resolves.toBeUndefined();
    expect(deps.failEval).toHaveBeenCalledWith(1, "insufficient_credit");
  });

  // `runs.triggering_message_id` is nullable, so the runner must handle null even though no
  // production path currently produces it — both createRun call sites set it, and the task
  // route synthesizes a message from the task brief so that one exists. A null is a normal
  // outcome, graded against the instructions alone; NOT a sixth failure code (the set is
  // closed at five; see the parent spec).
  it("judges with an undefined request when the run has no triggering message", async () => {
    const deps = makeDeps({ getRun: vi.fn().mockResolvedValue({ id: 7, sessionId: 12, status: "done" }) });
    await processEvalJob(1, deps);

    expect(deps.getTriggeringMessage).not.toHaveBeenCalled();
    expect(deps.judge).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
    expect(deps.completeEval).toHaveBeenCalledWith(1, RESULT, "claude-sonnet-5");
    expect(deps.failEval).not.toHaveBeenCalled();
  });

  it("completes normally when the triggering message row is gone", async () => {
    const deps = makeDeps({ getTriggeringMessage: vi.fn().mockResolvedValue(undefined) });
    await processEvalJob(1, deps);

    expect(deps.judge).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
    expect(deps.completeEval).toHaveBeenCalledWith(1, RESULT, "claude-sonnet-5");
    expect(deps.failEval).not.toHaveBeenCalled();
  });

  // An empty or whitespace-only chat message is no request at all. Passing it through would
  // emit an empty <request> block, and a block that exists — however empty — re-opens the
  // override gate that "no request block ⇒ no requirement may be overridden" holds shut.
  it.each(["", "   ", "\n\t \n"])("judges with an undefined request for a blank message (%j)", async (blank) => {
    const deps = makeDeps({ getTriggeringMessage: vi.fn().mockResolvedValue({ content: blank }) });
    await processEvalJob(1, deps);

    expect(deps.judge).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
    expect(deps.completeEval).toHaveBeenCalledWith(1, RESULT, "claude-sonnet-5");
    expect(deps.failEval).not.toHaveBeenCalled();
  });

  // A failed message lookup degrades to "no request" — it must never cost the user a graded
  // eval, and must never become a failure code of its own.
  it("completes normally when the triggering message lookup throws", async () => {
    const deps = makeDeps({ getTriggeringMessage: vi.fn().mockRejectedValue(new Error("connection refused")) });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(processEvalJob(1, deps)).resolves.toBeUndefined();

    expect(deps.judge).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
    expect(deps.completeEval).toHaveBeenCalledWith(1, RESULT, "claude-sonnet-5");
    expect(deps.failEval).not.toHaveBeenCalled();

    // Every other log in this file is keyed "Eval <id>: …"; a degraded eval that does not
    // carry its own row id cannot be tied back to the row it degraded.
    expect(logged).toHaveBeenCalledWith(
      "Eval 1: triggering message 55 lookup failed:",
      expect.any(Error),
    );
    logged.mockRestore();
  });
});
