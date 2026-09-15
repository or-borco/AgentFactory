import { describe, expect, it, vi } from "vitest";
import type { Run, RunCommitRange, Session, Task } from "@agentfactory/core";
import type { CloneTarget } from "../scm-provider";

// eval-artefact.ts (via scm-provider.ts) statically imports from "@agentfactory/db", whose
// client throws at import time if DATABASE_URL isn't set — true for the unit project, which
// runs with no database. This test drives resolveEvalArtefact entirely through the deps
// seam and never touches the real db module, so a lightweight mock (matching the pattern
// already used in scm-provider.test.ts) is enough to make the module graph loadable here.
vi.mock("@agentfactory/db", () => ({ getFinalAssistantMessageForRun: vi.fn(), listConnections: vi.fn() }));

const { ArtefactUnavailableError, resolveEvalArtefact } = await import("../eval-artefact");

const SESSION = { id: 12, orgId: 1, agentId: 3 } as unknown as Session;
const TASK_WITH_REPO = { id: 5, codebase: "acme/backend" } as Task;
const RANGE: RunCommitRange = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
// The run under test pushed commits; every case that needs "this run committed nothing"
// overrides commitRange and workspaceSnapshot explicitly.
const RUN_THAT_PUSHED = { id: 7, sessionId: 12, commitRange: RANGE } as unknown as Run;
const RUN_THAT_PUSHED_NOTHING = { id: 7, sessionId: 12 } as unknown as Run;
const TARGET: CloneTarget = {
  cloneUrl: "https://x-access-token:t@github.com/acme/backend.git",
  remoteUrl: "https://github.com/acme/backend.git",
  branch: "agent/session-12",
  repoFullName: "acme/backend",
  provider: "github",
  installationRef: 99,
};

function makeDeps(overrides: Partial<Parameters<typeof resolveEvalArtefact>[4]> = {}) {
  return {
    resolveTarget: vi.fn().mockResolvedValue(TARGET),
    fetchDiff: vi.fn().mockResolvedValue("diff --git a/f b/f\n+line"),
    getFinalMessage: vi.fn().mockResolvedValue({ content: "Final answer" }),
    ...overrides,
  };
}

describe("resolveEvalArtefact", () => {
  it("grades the diff of exactly the commits this run pushed, not the session branch's", async () => {
    const deps = makeDeps();
    const artefact = await resolveEvalArtefact(RUN_THAT_PUSHED, SESSION, TASK_WITH_REPO, 1, deps);

    expect(artefact).toEqual({ kind: "diff", text: "diff --git a/f b/f\n+line" });
    expect(deps.resolveTarget).toHaveBeenCalledWith(1, "acme/backend", "agent/session-12");
    // The run's own range reaches the fetch. This is the whole point: a sibling run pushing to
    // the same branch must not change what this run is graded against.
    expect(deps.fetchDiff).toHaveBeenCalledWith(TARGET, RANGE);
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("grades the final message when the run recorded no commits", async () => {
    const deps = makeDeps();
    const artefact = await resolveEvalArtefact(RUN_THAT_PUSHED_NOTHING, SESSION, TASK_WITH_REPO, 1, deps);

    expect(artefact).toEqual({ kind: "final_message", text: "Final answer" });
    // Never asked GitHub anything: whether this run committed is settled by the run's own
    // record, so a sibling run's commits on the same branch cannot pull it into a diff.
    expect(deps.resolveTarget).not.toHaveBeenCalled();
    expect(deps.fetchDiff).not.toHaveBeenCalled();
  });

  it("fails — never falls back — when the range diff fetch errors", async () => {
    const deps = makeDeps({ fetchDiff: vi.fn().mockRejectedValue(new Error("GitHub API compare failed: 500")) });
    await expect(resolveEvalArtefact(RUN_THAT_PUSHED, SESSION, TASK_WITH_REPO, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("fails when a recorded range compares empty — the commits were rewritten or dropped", async () => {
    const deps = makeDeps({ fetchDiff: vi.fn().mockResolvedValue("") });
    await expect(resolveEvalArtefact(RUN_THAT_PUSHED, SESSION, TASK_WITH_REPO, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("fails when no GitHub installation covers the repo (target unresolvable)", async () => {
    const deps = makeDeps({ resolveTarget: vi.fn().mockResolvedValue(undefined) });
    await expect(resolveEvalArtefact(RUN_THAT_PUSHED, SESSION, TASK_WITH_REPO, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("fails when the run pushed but its task no longer names a codebase", async () => {
    const deps = makeDeps();
    await expect(resolveEvalArtefact(RUN_THAT_PUSHED, SESSION, { id: 5 } as Task, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("fails for a legacy run that left files behind but recorded no range", async () => {
    // Committed before runs recorded ranges. Which commits on the branch were its own cannot be
    // recovered, and the session-wide diff this used to fall back on is the wrong document.
    const legacy = { id: 7, sessionId: 12, workspaceSnapshot: { "src/a.ts": "x" } } as unknown as Run;
    const deps = makeDeps();
    await expect(resolveEvalArtefact(legacy, SESSION, TASK_WITH_REPO, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("grades the final message when the task has no codebase and the run pushed nothing", async () => {
    const deps = makeDeps();
    const artefact = await resolveEvalArtefact(RUN_THAT_PUSHED_NOTHING, SESSION, { id: 5 } as Task, 1, deps);
    expect(artefact.kind).toBe("final_message");
    expect(deps.resolveTarget).not.toHaveBeenCalled();
  });

  it("fails when there is no final message to grade", async () => {
    const deps = makeDeps({ getFinalMessage: vi.fn().mockResolvedValue(undefined) });
    await expect(resolveEvalArtefact(RUN_THAT_PUSHED_NOTHING, SESSION, undefined, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
  });
});
