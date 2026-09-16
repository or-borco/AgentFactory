import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContext = vi.fn();
const getAgent = vi.fn();
const getTeamForOrg = vi.fn();
const duplicateAgent = vi.fn();
const enqueueRepoMapWarmJob = vi.fn();

// The real @agentfactory/db throws at import when DATABASE_URL is unset (client.ts), and
// @agentfactory/queue does the same without REDIS_URL — factory mocks keep both from loading.
vi.mock("@agentfactory/db", () => ({
  getAgent: (...args: unknown[]) => getAgent(...args),
  getTeamForOrg: (...args: unknown[]) => getTeamForOrg(...args),
  duplicateAgent: (...args: unknown[]) => duplicateAgent(...args),
}));
vi.mock("@agentfactory/queue", () => ({
  enqueueRepoMapWarmJob: (...args: unknown[]) => enqueueRepoMapWarmJob(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { POST } from "../route";

function post(agentId: string, body: Record<string, unknown>) {
  return POST(
    new Request(`http://localhost/api/agents/${agentId}/duplicate`, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ agentId }) },
  );
}

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  getAgent.mockReset();
  getTeamForOrg.mockReset();
  duplicateAgent.mockReset();
  enqueueRepoMapWarmJob.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/agents/[agentId]/duplicate", () => {
  it("401s without touching the db", async () => {
    requireAuthContext.mockResolvedValue(undefined);

    const res = await post("5", { teamId: 9 });

    expect(res.status).toBe(401);
    expect(getAgent).not.toHaveBeenCalled();
    expect(duplicateAgent).not.toHaveBeenCalled();
  });

  it("404s when the source agent belongs to another org", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 999 });

    const res = await post("5", { teamId: 9 });

    expect(res.status).toBe(404);
    expect(duplicateAgent).not.toHaveBeenCalled();
  });

  it("404s when the source agent doesn't exist", async () => {
    getAgent.mockResolvedValue(undefined);

    const res = await post("5", { teamId: 9 });

    expect(res.status).toBe(404);
    expect(duplicateAgent).not.toHaveBeenCalled();
  });

  it("400s when teamId is missing", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });

    const res = await post("5", {});

    expect(res.status).toBe(400);
    expect(getTeamForOrg).not.toHaveBeenCalled();
    expect(duplicateAgent).not.toHaveBeenCalled();
  });

  it("404s when the target team doesn't belong to the caller's org", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });
    getTeamForOrg.mockResolvedValue(undefined);

    const res = await post("5", { teamId: 9 });

    expect(res.status).toBe(404);
    expect(getTeamForOrg).toHaveBeenCalledExactlyOnceWith(9, 3);
    expect(duplicateAgent).not.toHaveBeenCalled();
  });

  it("duplicates the agent into the target team and returns 201", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });
    getTeamForOrg.mockResolvedValue({ id: 9, orgId: 3 });
    duplicateAgent.mockResolvedValue({ id: 50, orgId: 3, teamId: 9, name: "Copy of Reviewer" });

    const res = await post("5", { teamId: 9 });

    expect(res.status).toBe(201);
    expect(duplicateAgent).toHaveBeenCalledExactlyOnceWith(5, 9);
    await expect(res.json()).resolves.toMatchObject({ id: 50, name: "Copy of Reviewer" });
  });

  // Mirrors POST /api/agents: a duplicate that inherits a default codebase should warm the repo
  // map cache just like a freshly created agent would.
  it("warms the repo map when the duplicate has a default codebase", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });
    getTeamForOrg.mockResolvedValue({ id: 9, orgId: 3 });
    duplicateAgent.mockResolvedValue({ id: 50, orgId: 3, teamId: 9, defaultCodebase: "acme/backend" });

    const res = await post("5", { teamId: 9 });

    expect(res.status).toBe(201);
    expect(enqueueRepoMapWarmJob).toHaveBeenCalledExactlyOnceWith(3, "acme/backend");
  });

  it("does not warm anything when the duplicate has no default codebase", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });
    getTeamForOrg.mockResolvedValue({ id: 9, orgId: 3 });
    duplicateAgent.mockResolvedValue({ id: 50, orgId: 3, teamId: 9, defaultCodebase: undefined });

    await post("5", { teamId: 9 });

    expect(enqueueRepoMapWarmJob).not.toHaveBeenCalled();
  });

  it("still returns 201 when the queue is down", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });
    getTeamForOrg.mockResolvedValue({ id: 9, orgId: 3 });
    duplicateAgent.mockResolvedValue({ id: 50, orgId: 3, teamId: 9, defaultCodebase: "acme/backend" });
    enqueueRepoMapWarmJob.mockRejectedValue(new Error("redis down"));

    const res = await post("5", { teamId: 9 });

    expect(res.status).toBe(201);
  });

  it("404s if the source agent is deleted between lookup and duplication", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });
    getTeamForOrg.mockResolvedValue({ id: 9, orgId: 3 });
    duplicateAgent.mockResolvedValue(undefined);

    const res = await post("5", { teamId: 9 });

    expect(res.status).toBe(404);
  });
});
