import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContext = vi.fn();
const createTask = vi.fn();
const listTasks = vi.fn();
const enqueueRepoMapWarmJob = vi.fn();

// The real @agentfactory/db throws at import when DATABASE_URL is unset (client.ts), and
// @agentfactory/queue does the same without REDIS_URL — factory mocks keep both from loading.
vi.mock("@agentfactory/db", () => ({
  createTask: (...args: unknown[]) => createTask(...args),
  listTasks: (...args: unknown[]) => listTasks(...args),
}));
vi.mock("@agentfactory/queue", () => ({
  enqueueRepoMapWarmJob: (...args: unknown[]) => enqueueRepoMapWarmJob(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { POST } from "../route";

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  createTask.mockReset();
  listTasks.mockReset();
  enqueueRepoMapWarmJob.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/tasks", () => {
  it("401s without creating anything or touching the queue", async () => {
    requireAuthContext.mockResolvedValue(undefined);

    const res = await post({ title: "T" });

    expect(res.status).toBe(401);
    expect(createTask).not.toHaveBeenCalled();
    expect(enqueueRepoMapWarmJob).not.toHaveBeenCalled();
  });

  // The one-line omission behind task T-070's missing repo map: every other entry point that can
  // set a codebase warms the cache, and task creation — the most common one — did not.
  it("warms the repo map when the task is created with a codebase", async () => {
    createTask.mockResolvedValue({ id: 70, orgId: 3, codebase: "erakauf1/transcriber" });

    const res = await post({ title: "Add retries", codebase: "erakauf1/transcriber" });

    expect(res.status).toBe(201);
    expect(enqueueRepoMapWarmJob).toHaveBeenCalledExactlyOnceWith(3, "erakauf1/transcriber");
  });

  it("does not warm anything for a task with no codebase", async () => {
    createTask.mockResolvedValue({ id: 71, orgId: 3, codebase: undefined });

    const res = await post({ title: "Write a doc" });

    expect(res.status).toBe(201);
    expect(enqueueRepoMapWarmJob).not.toHaveBeenCalled();
  });

  // Best-effort, exactly like the other call sites: a Redis outage must not turn a successful
  // task creation into a 500. A missed warm only means the next run pays generation, as today.
  it("still returns 201 when the queue is down", async () => {
    createTask.mockResolvedValue({ id: 72, orgId: 3, codebase: "acme/widgets" });
    enqueueRepoMapWarmJob.mockRejectedValue(new Error("redis down"));

    const res = await post({ title: "Add retries", codebase: "acme/widgets" });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: 72 });
  });

  // The warm is scoped by the created task's own org, not by anything the request body supplied.
  it("warms against the task's org rather than a caller-supplied one", async () => {
    createTask.mockResolvedValue({ id: 73, orgId: 3, codebase: "acme/widgets" });

    await post({ title: "T", codebase: "acme/widgets", orgId: 999 });

    expect(enqueueRepoMapWarmJob).toHaveBeenCalledExactlyOnceWith(3, "acme/widgets");
  });

  it("rejects an invalid model id before creating or warming", async () => {
    const res = await post({ title: "T", codebase: "acme/widgets", model: { id: "not-a-model" } });

    expect(res.status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
    expect(enqueueRepoMapWarmJob).not.toHaveBeenCalled();
  });
});
