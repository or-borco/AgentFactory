import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));

const getTaskMock = vi.fn();
const getLatestNonTerminalRunMock = vi.fn();
const cancelRunMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getTask: (id: number) => getTaskMock(id),
  getLatestNonTerminalRun: (sessionId: number) => getLatestNonTerminalRunMock(sessionId),
  cancelRun: (id: number) => cancelRunMock(id),
}));

const enqueueRunCancelJobMock = vi.fn();
vi.mock("@agentfactory/queue", () => ({
  enqueueRunCancelJob: (...args: unknown[]) => enqueueRunCancelJobMock(...args),
}));

const { POST } = await import("../route");

function fakeTask(overrides: Partial<{ id: number; sessionId?: number }> = {}) {
  return {
    id: 7,
    orgId: 1,
    ref: "T-007",
    title: "Fix the thing",
    description: "Fix it",
    acceptanceCriteria: [],
    status: "in_progress",
    createdBy: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function request() {
  return new Request("http://x", { method: "POST" });
}

describe("POST /api/tasks/[taskId]/stop", () => {
  beforeEach(() => {
    requireAuthContextMock.mockReset();
    getTaskMock.mockReset();
    getLatestNonTerminalRunMock.mockReset();
    cancelRunMock.mockReset();
    enqueueRunCancelJobMock.mockReset();
  });

  it("returns 401 when not authenticated", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);
    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the task doesn't exist", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue(undefined);
    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the task has no active session", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue(fakeTask({ sessionId: undefined }));
    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(400);
    expect(getLatestNonTerminalRunMock).not.toHaveBeenCalled();
  });

  it("cancels the in-flight run and enqueues a sandbox kill job", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    const task = fakeTask({ sessionId: 55 });
    getTaskMock.mockResolvedValue(task);
    getLatestNonTerminalRunMock.mockResolvedValue({ id: 500, sessionId: 55, status: "running" });
    cancelRunMock.mockResolvedValue({ id: 500, sessionId: 55, status: "cancelled" });

    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(task);
    expect(cancelRunMock).toHaveBeenCalledWith(500);
    expect(enqueueRunCancelJobMock).toHaveBeenCalledWith(55);
  });

  it("is a no-op when there is no non-terminal run", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    const task = fakeTask({ sessionId: 55 });
    getTaskMock.mockResolvedValue(task);
    getLatestNonTerminalRunMock.mockResolvedValue(undefined);

    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });

    expect(res.status).toBe(200);
    expect(cancelRunMock).not.toHaveBeenCalled();
    expect(enqueueRunCancelJobMock).not.toHaveBeenCalled();
  });

  it("does not enqueue a kill job when cancelRun loses the race (run already finished)", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue(fakeTask({ sessionId: 55 }));
    getLatestNonTerminalRunMock.mockResolvedValue({ id: 500, sessionId: 55, status: "running" });
    cancelRunMock.mockResolvedValue(undefined);

    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });

    expect(res.status).toBe(200);
    expect(enqueueRunCancelJobMock).not.toHaveBeenCalled();
  });
});
