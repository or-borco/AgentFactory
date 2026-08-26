import type { EvalArtefactKind, Session, Task } from "@agentfactory/core";
import { getFinalAssistantMessageForRun } from "@agentfactory/db";
import { type CloneTarget, fetchBranchDiff, resolveCloneTarget } from "./scm-provider";

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
  fetchDiff: (target: CloneTarget) => Promise<string | undefined>;
  getFinalMessage: (runId: number) => Promise<{ content: string } | undefined>;
}

const defaultDeps: ArtefactDeps = {
  resolveTarget: resolveCloneTarget,
  fetchDiff: fetchBranchDiff,
  getFinalMessage: getFinalAssistantMessageForRun,
};

// The artefact rule (spec §Design decisions): run committed → the branch diff; never
// committed → the run's final assistant message; intended artefact unfetchable → throw,
// never fall back. A missing branch (fetchDiff → undefined) or an empty compare means the
// run never committed — that routes to the final message BY THE RULE, not as a fallback.
export async function resolveEvalArtefact(
  runId: number,
  session: Session,
  task: Task | undefined,
  orgId: number,
  deps: ArtefactDeps = defaultDeps,
): Promise<EvalArtefact> {
  if (task?.codebase) {
    let diff: string | undefined;
    try {
      const target = await deps.resolveTarget(orgId, task.codebase, `agent/session-${session.id}`);
      // undefined here means no GitHub installation for this org can see the repo at all —
      // a distinct condition from fetchDiff's "branch doesn't exist" 404, and not a "never
      // committed" signal. It must fail like any other unfetchable artefact, not fall through.
      if (!target) {
        throw new Error(`no GitHub installation found for repo "${task.codebase}"`);
      }
      diff = await deps.fetchDiff(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ArtefactUnavailableError(`branch diff fetch failed: ${message}`);
    }
    if (diff !== undefined && diff.trim() !== "") return { kind: "diff", text: diff };
  }

  const message = await deps.getFinalMessage(runId);
  if (!message || message.content.trim() === "") {
    throw new ArtefactUnavailableError(`run ${runId} has no final assistant message to grade`);
  }
  return { kind: "final_message", text: message.content };
}
