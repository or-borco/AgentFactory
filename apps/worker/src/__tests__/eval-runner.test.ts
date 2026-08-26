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
    getRun: vi.fn().mockResolvedValue({ id: 7, sessionId: 12, status: "done" }),
    getRunPrompt: vi.fn().mockResolvedValue({ runId: 7, segments: SEGMENTS }),
    getSession: vi.fn().mockResolvedValue({ id: 12, orgId: 2, agentId: 3 }),
    getTaskBySessionId: vi.fn().mockResolvedValue({ id: 5, codebase: "acme/backend" }),
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
    // Only the human-authored layer reaches the judge.
    expect(deps.judge).toHaveBeenCalledWith(
      [{ id: "agent_system_prompt", text: "You are a reviewer." }],
      { kind: "diff", text: "+line" },
    );
    expect(deps.resolveArtefact).toHaveBeenCalledWith(7, { id: 12, orgId: 2, agentId: 3 }, { id: 5, codebase: "acme/backend" }, 2);
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

  it("drops the job quietly when the eval row is gone", async () => {
    const deps = makeDeps({ getRunEval: vi.fn().mockResolvedValue(undefined) });
    await processEvalJob(1, deps);
    expect(deps.markEvalRunning).not.toHaveBeenCalled();
    expect(deps.failEval).not.toHaveBeenCalled();
  });
});
