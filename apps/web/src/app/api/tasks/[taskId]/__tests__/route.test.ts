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

import { PATCH } from "../route";

function patch(taskId: string, body: Record<string, unknown>) {
  return PATCH(new Request(`http://localhost/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(body) }), {
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

describe("PATCH /api/tasks/[taskId] — memory retrospective", () => {
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
