import type { PromptSegment, Run, RunEval, RunEvalResult, Session, Task } from "@agentfactory/core";
import {
  completeEval,
  failEval,
  getRun,
  getRunEval,
  getRunPrompt,
  getSession,
  getTaskBySessionId,
  markEvalRunning,
} from "@agentfactory/db";
import { ArtefactUnavailableError, type EvalArtefact, resolveEvalArtefact } from "./eval-artefact";
import { judgeCompliance, selectHumanSegments } from "./eval-judge";

// Narrow function types rather than typeof imports so unit tests can stub each seam with a
// plain vi.fn() — the production defaults are structurally compatible.
export interface EvalRunnerDeps {
  getRunEval: (id: number) => Promise<RunEval | undefined>;
  getRun: (id: number) => Promise<Run | undefined>;
  getRunPrompt: (id: number) => Promise<{ segments: PromptSegment[] } | undefined>;
  getSession: (id: number) => Promise<Session | undefined>;
  getTaskBySessionId: (sessionId: number) => Promise<Task | undefined>;
  markEvalRunning: (id: number) => Promise<void>;
  completeEval: (id: number, result: RunEvalResult, judgeModelId: string) => Promise<RunEval>;
  failEval: (id: number, error: string) => Promise<RunEval>;
  resolveArtefact: (runId: number, session: Session, task: Task | undefined, orgId: number) => Promise<EvalArtefact>;
  judge: (segments: PromptSegment[], artefact: EvalArtefact) => Promise<{ result: RunEvalResult; judgeModelId: string }>;
}

const defaultDeps: EvalRunnerDeps = {
  getRunEval,
  getRun,
  getRunPrompt,
  getSession,
  getTaskBySessionId,
  markEvalRunning,
  completeEval,
  failEval,
  resolveArtefact: resolveEvalArtefact,
  judge: judgeCompliance,
};

function classifyJudgeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Same account-out-of-credits surface the run path classifies (#99) — the provider says
  // "credit balance is too low"; everything else is a generic judge failure.
  return message.toLowerCase().includes("credit balance") ? "insufficient_credit" : "judge_error";
}

// The spec's five steps, in order. Every failure ends as a `failed` row with one
// machine-readable reason — the row IS the failure record, so this never rethrows into
// BullMQ retries: the user re-triggers manually, and auto-retrying a judge call would
// only double-bill.
export async function processEvalJob(evalId: number, deps: EvalRunnerDeps = defaultDeps): Promise<void> {
  const evalRow = await deps.getRunEval(evalId);
  if (!evalRow) {
    // Cascade delete beat the job to it (run/session/org removed) — nothing left to grade
    // and no row to record a failure on.
    console.error(`Eval ${evalId} not found; dropping job`);
    return;
  }

  await deps.markEvalRunning(evalId);
  try {
    const run = await deps.getRun(evalRow.runId);
    if (!run) {
      await deps.failEval(evalId, "artefact_unavailable");
      return;
    }

    // 1. No stored prompt → the run failed before composing one; nothing to grade against.
    const prompt = await deps.getRunPrompt(run.id);
    const segments = prompt?.segments ?? [];
    if (segments.length === 0) {
      await deps.failEval(evalId, "run_never_composed_prompt");
      return;
    }

    // 2. Only human-authored layers are judged.
    const humanSegments = selectHumanSegments(segments);
    if (humanSegments.length === 0) {
      await deps.failEval(evalId, "no_human_context");
      return;
    }

    // 3. The artefact rule — diff or final message, never a silent fallback.
    const session = await deps.getSession(run.sessionId);
    if (!session) {
      await deps.failEval(evalId, "artefact_unavailable");
      return;
    }
    const task = await deps.getTaskBySessionId(session.id);
    let artefact: EvalArtefact;
    try {
      artefact = await deps.resolveArtefact(run.id, session, task, evalRow.orgId);
    } catch (err) {
      if (err instanceof ArtefactUnavailableError) {
        console.error(`Eval ${evalId}: ${err.message}`);
        await deps.failEval(evalId, "artefact_unavailable");
        return;
      }
      throw err;
    }

    // 4-5. One structured-output judge call; store result + judge model, mark done.
    const { result, judgeModelId } = await deps.judge(humanSegments, artefact);
    await deps.completeEval(evalId, result, judgeModelId);
  } catch (err) {
    console.error(`Eval ${evalId} failed:`, err);
    await deps.failEval(evalId, classifyJudgeError(err));
  }
}
