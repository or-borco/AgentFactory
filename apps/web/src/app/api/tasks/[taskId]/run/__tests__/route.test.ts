import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));

const getTaskMock = vi.fn();
const startTaskSessionMock = vi.fn();
const createRunMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getTask: (id: number) => getTaskMock(id),
  startTaskSession: (...args: unknown[]) => startTaskSessionMock(...args),
  createRun: (...args: unknown[]) => createRunMock(...args),
}));

const checkTaskSyncMock = vi.fn();
vi.mock("@/server/task-sync", () => ({ checkTaskSync: (...args: unknown[]) => checkTaskSyncMock(...args) }));

const enqueueRunJobMock = vi.fn();
vi.mock("@agentfactory/queue", () => ({ enqueueRunJob: (...args: unknown[]) => enqueueRunJobMock(...args) }));

const { POST } = await import("../route");

function fakeTask(overrides: Partial<{ id: number; assigneeAgentId?: number; sessionId?: number; externalRef?: unknown }> = {}) {
  return {
    id: 7,
    orgId: 1,
    ref: "T-007",
    title: "Fix the thing",
    description: "Fix it",
    acceptanceCriteria: [],
    status: "assigned",
    createdBy: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function request(body?: unknown) {
  return new Request("http://x", { method: "POST", body: body ? JSON.stringify(body) : undefined });
}

describe("POST /api/tasks/[taskId]/run", () => {
  beforeEach(() => {
    requireAuthContextMock.mockReset();
    getTaskMock.mockReset();
    startTaskSessionMock.mockReset();
    createRunMock.mockReset();
    checkTaskSyncMock.mockReset();
    enqueueRunJobMock.mockReset();
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

  it("returns 400 when the task has no assignee", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue(fakeTask({ assigneeAgentId: undefined }));
    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the task already has a session", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue(fakeTask({ assigneeAgentId: 3, sessionId: 99 }));
    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(409);
  });

  it("starts the session and enqueues a run on success", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    const task = fakeTask({ assigneeAgentId: 3 });
    getTaskMock.mockResolvedValue(task);
    const session = { id: 55, agentId: 3, title: task.title, origin: "web", createdAt: "", lastActivityAt: "" };
    startTaskSessionMock.mockResolvedValue({ started: true, session, userMessageId: 900, task: { ...task, sessionId: 55 } });
    createRunMock.mockResolvedValue({ id: 500 });

    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ task: { ...task, sessionId: 55 }, session, runId: 500 });
    expect(enqueueRunJobMock).toHaveBeenCalledWith(500);
    expect(startTaskSessionMock).toHaveBeenCalledWith(7, 1, 3, task.title, "Fix it", { origin: "web" });
  });

  it("returns 409 when startTaskSession loses the race", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    const task = fakeTask({ assigneeAgentId: 3 });
    getTaskMock.mockResolvedValue(task);
    startTaskSessionMock.mockResolvedValue({ started: false, task });

    const res = await POST(request(), { params: Promise.resolve({ taskId: "7" }) });

    expect(res.status).toBe(409);
    expect(enqueueRunJobMock).not.toHaveBeenCalled();
  });
});
