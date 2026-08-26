import { describe, expect, it, vi } from "vitest";
import type { Session, Task } from "@agentfactory/core";
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
const TARGET: CloneTarget = {
  cloneUrl: "https://x-access-token:t@github.com/acme/backend.git",
  branch: "agent/session-12",
  repoFullName: "acme/backend",
  installationId: 99,
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
  it("grades the branch diff when the task has a codebase and the branch has changes", async () => {
    const deps = makeDeps();
    const artefact = await resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps);

    expect(artefact).toEqual({ kind: "diff", text: "diff --git a/f b/f\n+line" });
    expect(deps.resolveTarget).toHaveBeenCalledWith(1, "acme/backend", "agent/session-12");
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("grades the final message when the branch does not exist (run never committed)", async () => {
    const deps = makeDeps({ fetchDiff: vi.fn().mockResolvedValue(undefined) });
    const artefact = await resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps);
    expect(artefact).toEqual({ kind: "final_message", text: "Final answer" });
  });

  it("grades the final message when the compare is empty (branch exists, nothing committed)", async () => {
    const deps = makeDeps({ fetchDiff: vi.fn().mockResolvedValue("") });
    const artefact = await resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps);
    expect(artefact.kind).toBe("final_message");
  });

  it("fails — never falls back — when the diff fetch errors", async () => {
    const deps = makeDeps({ fetchDiff: vi.fn().mockRejectedValue(new Error("GitHub API compare failed: 500")) });
    await expect(resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("fails when no GitHub installation covers the repo (target unresolvable)", async () => {
    const deps = makeDeps({ resolveTarget: vi.fn().mockResolvedValue(undefined) });
    await expect(resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("grades the final message directly when the task has no codebase", async () => {
    const deps = makeDeps();
    const artefact = await resolveEvalArtefact(7, SESSION, { id: 5 } as Task, 1, deps);
    expect(artefact.kind).toBe("final_message");
    expect(deps.resolveTarget).not.toHaveBeenCalled();
  });

  it("fails when there is no final message to grade", async () => {
    const deps = makeDeps({ getFinalMessage: vi.fn().mockResolvedValue(undefined) });
    await expect(resolveEvalArtefact(7, SESSION, undefined, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
  });
});
