import type { EvalArtefactKind, Run, RunCommitRange, Session, Task } from "@agentfactory/core";
import { getFinalAssistantMessageForRun } from "@agentfactory/db";
import { type CloneTarget, fetchCommitRangeDiff, resolveCloneTarget, sessionBranchName } from "./scm-provider";

export interface EvalArtefact {
  kind: EvalArtefactKind;
  text: string;
}

// Raised when the artefact the rule selected cannot be produced. The eval must then fail —
// a score that quietly graded the wrong document is the worst output this feature can emit.
export class ArtefactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtefactUnavailableError";
  }
}

// Dependency seam for unit tests; production callers rely on the defaults.
export interface ArtefactDeps {
  resolveTarget: (orgId: number, codebase: string, branch: string) => Promise<CloneTarget | undefined>;
  fetchDiff: (target: CloneTarget, range: RunCommitRange) => Promise<string>;
  getFinalMessage: (runId: number) => Promise<{ content: string } | undefined>;
}

const defaultDeps: ArtefactDeps = {
  resolveTarget: resolveCloneTarget,
  fetchDiff: fetchCommitRangeDiff,
  getFinalMessage: getFinalAssistantMessageForRun,
};

// The artefact rule (spec §Design decisions): run committed → its diff; never committed → the
// run's final assistant message; intended artefact unfetchable → throw, never fall back.
//
// "Did THIS run commit?" is answered by the run's own recorded commit range, never by the state
// of the session's branch. A session's branch accumulates every run's work, so a branch-wide
// diff would grade run 1 against run 3's commits — and the answer is not recoverable after the
// fact, which is why runs record the range at push time.
export async function resolveEvalArtefact(
  run: Run,
  session: Session,
  task: Task | undefined,
  orgId: number,
  deps: ArtefactDeps = defaultDeps,
): Promise<EvalArtefact> {
  if (run.commitRange) {
    const range = run.commitRange;
    let diff: string;
    try {
      if (!task?.codebase) {
        // The run pushed, so a repo existed then; the task has since lost its codebase and we
        // can no longer say where. Unfetchable, not never-committed.
        throw new Error("run recorded a commit range but its task has no codebase");
      }
      const target = await deps.resolveTarget(orgId, task.codebase, sessionBranchName(session));
      // undefined here means no GitHub installation for this org can see the repo at all.
      if (!target) {
        throw new Error(`no GitHub installation found for repo "${task.codebase}"`);
      }
      diff = await deps.fetchDiff(target, range);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ArtefactUnavailableError(`commit range diff fetch failed: ${message}`);
    }
    if (diff.trim() === "") {
      // A recorded range that compares empty contradicts itself — the commits were rewritten or
      // dropped. Grading the chat reply instead would silently score the wrong document for a
      // run we know produced code, so this fails rather than falls through.
      throw new ArtefactUnavailableError(
        `run ${run.id} recorded commits ${range.baseSha}...${range.headSha} but their diff is empty`,
      );
    }
    return { kind: "diff", text: diff };
  }

  // No range, but the run left files behind: it committed before runs recorded ranges. Which
  // commits on the branch were its own is genuinely unknowable now, and the session-wide diff
  // this feature used to fall back on is exactly the wrong document.
  if (run.workspaceSnapshot && Object.keys(run.workspaceSnapshot).length > 0) {
    throw new ArtefactUnavailableError(`run ${run.id} committed before commit ranges were recorded`);
  }

  const message = await deps.getFinalMessage(run.id);
  if (!message || message.content.trim() === "") {
    throw new ArtefactUnavailableError(`run ${run.id} has no final assistant message to grade`);
  }
  return { kind: "final_message", text: message.content };
}
