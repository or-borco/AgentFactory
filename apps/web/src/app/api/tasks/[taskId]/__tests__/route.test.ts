import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContext = vi.fn();
const getTask = vi.fn();
const updateTask = vi.fn();
const deleteTask = vi.fn();
const enqueueSandboxTeardownJob = vi.fn();
const enqueueRepoMapWarmJob = vi.fn();
const enqueueMemoryRetrospectiveJob = vi.fn();

vi.mock("@agentfactory/db", () => ({
  getTask: (...args: unknown[]) => getTask(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
  deleteTask: (...args: unknown[]) => deleteTask(...args),
}));
vi.mock("@agentfactory/queue", () => ({
  enqueueSandboxTeardownJob: (...args: unknown[]) => enqueueSandboxTeardownJob(...args),
  enqueueRepoMapWarmJob: (...args: unknown[]) => enqueueRepoMapWarmJob(...args),
  enqueueMemoryRetrospectiveJob: (...args: unknown[]) => enqueueMemoryRetrospectiveJob(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { DELETE, PATCH } from "../route";

function patch(taskId: string, body: Record<string, unknown>) {
  return PATCH(new Request(`http://localhost/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ taskId }),
  });
}

function del(taskId: string) {
  return DELETE(new Request(`http://localhost/api/tasks/${taskId}`, { method: "DELETE" }), {
    params: Promise.resolve({ taskId }),
  });
}

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  getTask.mockReset();
  updateTask.mockReset();
  deleteTask.mockReset();
  enqueueSandboxTeardownJob.mockReset().mockResolvedValue(undefined);
  enqueueRepoMapWarmJob.mockReset().mockResolvedValue(undefined);
  enqueueMemoryRetrospectiveJob.mockReset().mockResolvedValue(undefined);
});

describe("PATCH /api/tasks/[taskId], memory retrospective", () => {
  it.each(["done", "failed", "cancelled"] as const)(
    "enqueues a retrospective job when status becomes %s and the task has a session and an assignee",
    async (status) => {
      updateTask.mockResolvedValue({
        id: 5,
        orgId: 3,
        status,
        sessionId: 9,
        assigneeAgentId: 7,
        codebase: null,
      });

      await patch("5", { status });

      expect(enqueueMemoryRetrospectiveJob).toHaveBeenCalledExactlyOnceWith(3, 7, 9);
    },
  );

  it("does not enqueue when the task has no session", async () => {
    updateTask.mockResolvedValue({ id: 5, orgId: 3, status: "done", sessionId: null, assigneeAgentId: 7 });

    await patch("5", { status: "done" });

    expect(enqueueMemoryRetrospectiveJob).not.toHaveBeenCalled();
  });

  it("does not enqueue when the task has no assignee", async () => {
    updateTask.mockResolvedValue({ id: 5, orgId: 3, status: "done", sessionId: 9, assigneeAgentId: null });

    await patch("5", { status: "done" });

    expect(enqueueMemoryRetrospectiveJob).not.toHaveBeenCalled();
  });

  it("does not enqueue for a non-terminal status", async () => {
    updateTask.mockResolvedValue({ id: 5, orgId: 3, status: "in_progress", sessionId: 9, assigneeAgentId: 7 });

    await patch("5", { status: "in_progress" });

    expect(enqueueMemoryRetrospectiveJob).not.toHaveBeenCalled();
  });

  it("still returns the updated task when the queue is down", async () => {
    updateTask.mockResolvedValue({ id: 5, orgId: 3, status: "done", sessionId: 9, assigneeAgentId: 7 });
    enqueueMemoryRetrospectiveJob.mockRejectedValue(new Error("redis down"));

    const res = await patch("5", { status: "done" });

    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/tasks/[taskId], memory retrospective", () => {
  // Deleting a task is itself the terminal event for its session, whatever TaskStatus the task
  // happened to be in — unlike PATCH, there's no "new status" to gate on here, and a task can be
  // deleted from a non-terminal status too (e.g. "pr_open", after real work already happened but
  // before the task was ever marked done/failed/cancelled). Parametrized over both a terminal and
  // a non-terminal status to prove the DELETE path doesn't reuse PATCH's TERMINAL_TASK_STATUSES
  // gate.
  it.each(["pr_open", "done", "in_progress"] as const)(
    "enqueues a retrospective job on delete when the task has a session and an assignee, regardless of status (%s)",
    async (status) => {
      getTask.mockResolvedValue({ id: 5, orgId: 3, status, sessionId: 9, assigneeAgentId: 7 });

      await del("5");

      expect(enqueueMemoryRetrospectiveJob).toHaveBeenCalledExactlyOnceWith(3, 7, 9);
    },
  );

  it("does not enqueue when the task has no session", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "pr_open", sessionId: null, assigneeAgentId: 7 });

    await del("5");

    expect(enqueueMemoryRetrospectiveJob).not.toHaveBeenCalled();
  });

  it("does not enqueue when the task has no assignee", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "pr_open", sessionId: 9, assigneeAgentId: null });

    await del("5");

    expect(enqueueMemoryRetrospectiveJob).not.toHaveBeenCalled();
  });

  it("still tears down the sandbox and deletes the task", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "pr_open", sessionId: 9, assigneeAgentId: 7 });

    const res = await del("5");

    expect(enqueueSandboxTeardownJob).toHaveBeenCalledExactlyOnceWith(9);
    expect(deleteTask).toHaveBeenCalledExactlyOnceWith(5);
    expect(res.status).toBe(204);
  });

  it("still returns 204 when the retrospective queue is down", async () => {
    getTask.mockResolvedValue({ id: 5, orgId: 3, status: "pr_open", sessionId: 9, assigneeAgentId: 7 });
    enqueueMemoryRetrospectiveJob.mockRejectedValue(new Error("redis down"));

    const res = await del("5");

    expect(res.status).toBe(204);
  });

  it("returns 404 without enqueueing anything when the task doesn't exist", async () => {
    getTask.mockResolvedValue(undefined);

    const res = await del("5");

    expect(res.status).toBe(404);
    expect(enqueueMemoryRetrospectiveJob).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });
});
