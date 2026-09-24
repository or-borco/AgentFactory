import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContext = vi.fn();
const getTask = vi.fn();
const revertTaskFromDone = vi.fn();
const resolveScmConnection = vi.fn();
const fetchPullRequest = vi.fn();

vi.mock("@agentfactory/db", () => ({
  getTask: (...args: unknown[]) => getTask(...args),
  revertTaskFromDone: (...args: unknown[]) => revertTaskFromDone(...args),
}));
vi.mock("@agentfactory/scm", () => ({
  resolveScmConnection: (...args: unknown[]) => resolveScmConnection(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { POST } from "../route";

function revert(taskId: string) {
  return POST(new Request(`http://localhost/api/tasks/${taskId}/revert`, { method: "POST" }), {
    params: Promise.resolve({ taskId }),
  });
}

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  getTask.mockReset();
  revertTaskFromDone.mockReset();
  resolveScmConnection.mockReset();
  fetchPullRequest.mockReset();
});

describe("POST /api/tasks/[taskId]/revert", () => {
  it("returns 401 when unauthenticated", async () => {
    requireAuthContext.mockResolvedValue(null);

    const res = await revert("5");

    expect(res.status).toBe(401);
    expect(getTask).not.toHaveBeenCalled();
  });

  it("returns 404 when the task doesn't exist", async () => {
    getTask.mockResolvedValue(undefined);

    const res = await revert("5");

    expect(res.status).toBe(404);
  });

  it("returns 409 when the task isn't done", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "in_progress" });

    const res = await revert("5");

    expect(res.status).toBe(409);
    expect(revertTaskFromDone).not.toHaveBeenCalled();
  });

  it("reverts to assigned and keeps the session when the task never had a PR", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "done", sessionId: 9, codebase: "acme/repo" });
    revertTaskFromDone.mockResolvedValue({ id: 5, orgId: 3, status: "assigned", sessionId: 9 });

    const res = await revert("5");

    expect(resolveScmConnection).not.toHaveBeenCalled();
    expect(revertTaskFromDone).toHaveBeenCalledExactlyOnceWith(5, 3, { clearSession: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "assigned", sessionId: 9 });
  });

  it("keeps the existing session/branch when the PR is still open", async () => {
    getTask.mockResolvedValue({
      id: 5,
      orgId: 3,
      status: "done",
      sessionId: 9,
      codebase: "acme/repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    resolveScmConnection.mockResolvedValue({ connection: { id: 1 }, provider: { fetchPullRequest } });
    fetchPullRequest.mockResolvedValue({ state: "open" });
    revertTaskFromDone.mockResolvedValue({ id: 5, orgId: 3, status: "assigned", sessionId: 9 });

    await revert("5");

    expect(fetchPullRequest).toHaveBeenCalledExactlyOnceWith({ id: 1 }, "acme/repo", 42);
    expect(revertTaskFromDone).toHaveBeenCalledExactlyOnceWith(5, 3, { clearSession: false });
  });

  it("clears the session so the next run starts a fresh branch when the PR was merged", async () => {
    getTask.mockResolvedValue({
      id: 5,
      orgId: 3,
      status: "done",
      sessionId: 9,
      codebase: "acme/repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    resolveScmConnection.mockResolvedValue({ connection: { id: 1 }, provider: { fetchPullRequest } });
    fetchPullRequest.mockResolvedValue({ state: "merged" });
    revertTaskFromDone.mockResolvedValue({ id: 5, orgId: 3, status: "assigned", sessionId: null });

    const res = await revert("5");

    expect(revertTaskFromDone).toHaveBeenCalledExactlyOnceWith(5, 3, { clearSession: true });
    expect(await res.json()).toMatchObject({ status: "assigned", sessionId: null });
  });

  it("defaults to keeping the branch when no GitHub connection can be resolved", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "done", sessionId: 9, codebase: "acme/repo", prNumber: 42 });
    resolveScmConnection.mockResolvedValue(undefined);
    revertTaskFromDone.mockResolvedValue({ id: 5, orgId: 3, status: "assigned", sessionId: 9 });

    await revert("5");

    expect(fetchPullRequest).not.toHaveBeenCalled();
    expect(revertTaskFromDone).toHaveBeenCalledExactlyOnceWith(5, 3, { clearSession: false });
  });

  it("defaults to keeping the branch when the GitHub lookup itself fails", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "done", sessionId: 9, codebase: "acme/repo", prNumber: 42 });
    resolveScmConnection.mockResolvedValue({ connection: { id: 1 }, provider: { fetchPullRequest } });
    fetchPullRequest.mockRejectedValue(new Error("GitHub is down"));
    revertTaskFromDone.mockResolvedValue({ id: 5, orgId: 3, status: "assigned", sessionId: 9 });

    const res = await revert("5");

    expect(revertTaskFromDone).toHaveBeenCalledExactlyOnceWith(5, 3, { clearSession: false });
    expect(res.status).toBe(200);
  });

  it("returns 409 when the task stopped being done before the update landed", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "done", sessionId: 9 });
    revertTaskFromDone.mockResolvedValue(undefined);

    const res = await revert("5");

    expect(res.status).toBe(409);
  });
});
