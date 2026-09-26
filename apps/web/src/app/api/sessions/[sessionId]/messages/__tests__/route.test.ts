import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContext = vi.fn();
const createMessage = vi.fn();
const touchSessionActivity = vi.fn();
const getSession = vi.fn();
const createRun = vi.fn();
const getTaskBySessionId = vi.fn();
const updateTask = vi.fn();
const enqueueRunJob = vi.fn();

// The real @agentfactory/db throws at import when DATABASE_URL is unset (client.ts), and
// @agentfactory/queue does the same without REDIS_URL — factory mocks keep both from loading.
vi.mock("@agentfactory/db", () => ({
  createMessage: (...args: unknown[]) => createMessage(...args),
  touchSessionActivity: (...args: unknown[]) => touchSessionActivity(...args),
  getSession: (...args: unknown[]) => getSession(...args),
  createRun: (...args: unknown[]) => createRun(...args),
  getTaskBySessionId: (...args: unknown[]) => getTaskBySessionId(...args),
  updateTask: (...args: unknown[]) => updateTask(...args),
  listMessages: (...args: unknown[]) => vi.fn()(...args),
}));
vi.mock("@agentfactory/queue", () => ({
  enqueueRunJob: (...args: unknown[]) => enqueueRunJob(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { POST } from "../route";

function post(sessionId: number, body: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ sessionId: String(sessionId) }) },
  );
}

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  createMessage.mockReset().mockResolvedValue({ id: 500, role: "user", text: "hi" });
  touchSessionActivity.mockReset().mockResolvedValue(undefined);
  getSession.mockReset().mockResolvedValue({ id: 10 });
  createRun.mockReset().mockResolvedValue({ id: 900 });
  getTaskBySessionId.mockReset().mockResolvedValue(undefined);
  updateTask.mockReset().mockResolvedValue(undefined);
  enqueueRunJob.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/sessions/[sessionId]/messages", () => {
  it("moves the owning task back to in_progress when a new instruction follows a failed run", async () => {
    getTaskBySessionId.mockResolvedValue({ id: 42, status: "failed" });

    const res = await post(10, { text: "try again" });

    expect(res.status).toBe(201);
    expect(updateTask).toHaveBeenCalledExactlyOnceWith(42, { status: "in_progress" });
  });

  it("leaves the task status alone when it isn't failed", async () => {
    getTaskBySessionId.mockResolvedValue({ id: 42, status: "pr_open" });

    const res = await post(10, { text: "one more thing" });

    expect(res.status).toBe(201);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled"])("answers 409 without recording the message or starting a run when the task is %s", async (status) => {
    getTaskBySessionId.mockResolvedValue({ id: 42, status });

    const res = await post(10, { text: "one more thing" });

    expect(res.status).toBe(409);
    expect(createMessage).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(enqueueRunJob).not.toHaveBeenCalled();
  });

  it("does nothing task-related when the session has no owning task", async () => {
    getTaskBySessionId.mockResolvedValue(undefined);

    const res = await post(10, { text: "hi" });

    expect(res.status).toBe(201);
    expect(updateTask).not.toHaveBeenCalled();
  });
});
