import type { PromptSegment, Run, RunEval, RunEvalResult, Session, Task } from "@agentfactory/core";
import {
  completeEval,
  failEval,
  getMessage,
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
  // Narrowed to the one field the judge needs. `getMessage` returns a full ChatMessage, which
  // is structurally compatible; keeping the seam this small keeps the stub in tests honest.
  getTriggeringMessage: (messageId: number) => Promise<{ content: string } | undefined>;
  markEvalRunning: (id: number) => Promise<void>;
  completeEval: (id: number, result: RunEvalResult, judgeModelId: string) => Promise<RunEval>;
  failEval: (id: number, error: string) => Promise<RunEval>;
  resolveArtefact: (run: Run, session: Session, task: Task | undefined, orgId: number) => Promise<EvalArtefact>;
  judge: (
    segments: PromptSegment[],
    artefact: EvalArtefact,
    request: string | undefined,
  ) => Promise<{ result: RunEvalResult; judgeModelId: string }>;
}

const defaultDeps: EvalRunnerDeps = {
  getRunEval,
  getRun,
  getRunPrompt,
  getSession,
  getTaskBySessionId,
  getTriggeringMessage: getMessage,
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

// The judge grades the artefact against the instructions AND against what the user actually
// asked for: without the request, an agent that obeyed a user asking for something narrower
// than its configured default reads as disobedient. Two paths land on `undefined` and both are
// normal, not failures — a run started by task assignment has no triggering message at all,
// and a lookup that returns nothing or throws leaves the eval graded on the instructions alone
// rather than costing the user a graded result over one missing row.
async function resolveRequest(run: Run, deps: EvalRunnerDeps): Promise<string | undefined> {
  const messageId = run.triggeringMessageId;
  if (!messageId) return undefined;
  try {
    const message = await deps.getTriggeringMessage(messageId);
    return message?.content;
  } catch (err) {
    console.error(`Eval: triggering message ${messageId} lookup failed:`, err);
    return undefined;
  }
}

// The spec's five steps, in order. Once the eval row is loaded below, every path ends in a
// terminal row — `done`, or `failed` with a machine-readable reason — and this function
// itself never throws or rejects. It never rethrows into BullMQ retries: the user
// re-triggers manually, and auto-retrying a judge call would only double-bill. The read at
// the very top (deps.getRunEval) is the one step outside that guarantee: if there is no row,
// there is nothing to record a failure on, so a failure there can only be logged and dropped.
export async function processEvalJob(evalId: number, deps: EvalRunnerDeps = defaultDeps): Promise<void> {
  const evalRow = await deps.getRunEval(evalId);
  if (!evalRow) {
    // Cascade delete beat the job to it (run/session/org removed) — nothing left to grade
    // and no row to record a failure on.
    console.error(`Eval ${evalId} not found; dropping job`);
    return;
  }

  // BullMQ's stalled-job recovery can re-deliver a job after a worker crash. Re-running a row
  // that already left "queued" would re-bill the judge call and, for a "done" row, walk it
  // back through "running" before landing on "done" again — or clobber a "failed" row's
  // terminal reason. Only a fresh "queued" row may proceed past this point.
  if (evalRow.status !== "queued") {
    console.error(`Eval ${evalId} is already ${evalRow.status}; skipping redelivered job`);
    return;
  }

  try {
    // Inside the try: markEvalRunning is itself a DB write and can fail. Once we're past the
    // row-existence check above, every subsequent failure — including this one — must land on
    // a terminal row rather than escape and leave it stuck "running" with no reason code.
    await deps.markEvalRunning(evalId);
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
      artefact = await deps.resolveArtefact(run, session, task, evalRow.orgId);
    } catch (err) {
      if (err instanceof ArtefactUnavailableError) {
        console.error(`Eval ${evalId}: ${err.message}`);
        await deps.failEval(evalId, "artefact_unavailable");
        return;
      }
      throw err;
    }

    // 4-5. One structured-output judge call; store result + judge model, mark done.
    const request = await resolveRequest(run, deps);
    const { result, judgeModelId } = await deps.judge(humanSegments, artefact, request);
    await deps.completeEval(evalId, result, judgeModelId);
  } catch (err) {
    console.error(`Eval ${evalId} failed:`, err);
    try {
      await deps.failEval(evalId, classifyJudgeError(err));
    } catch (writeErr) {
      // The failure write itself failed — nothing left to record it on. Log and stop; this
      // function must not reject regardless of what broke.
      console.error(`Eval ${evalId}: failed to record failure:`, writeErr);
    }
  }
}
