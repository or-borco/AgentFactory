import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const resolveScmConnectionMock = vi.fn();
const resolveDefaultBranchShaMock = vi.fn();
const getRepoMapMock = vi.fn();
const enqueueRepoMapWarmJobMock = vi.fn();

vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));
vi.mock("@agentfactory/scm", () => ({
  resolveScmConnection: (...args: unknown[]) => resolveScmConnectionMock(...args),
}));
// @agentfactory/db and @agentfactory/queue both throw at import when their env vars are unset,
// which they are in the unit test env — mock both out, same pattern as
// apps/web/src/app/api/tasks/__tests__/route.test.ts.
vi.mock("@agentfactory/db", () => ({ getRepoMap: (...args: unknown[]) => getRepoMapMock(...args) }));
vi.mock("@agentfactory/queue", () => ({
  enqueueRepoMapWarmJob: (...args: unknown[]) => enqueueRepoMapWarmJobMock(...args),
}));

import { GET, POST } from "../route";

function getRequest(codebase?: string) {
  const url = new URL("http://localhost/api/repos/map-status");
  if (codebase !== undefined) url.searchParams.set("codebase", codebase);
  return new Request(url);
}

function postRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/repos/map-status", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  requireAuthContextMock.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  resolveScmConnectionMock.mockReset().mockResolvedValue({
    provider: { resolveDefaultBranchSha: resolveDefaultBranchShaMock },
    connection: { id: 1, orgId: 3, provider: "github", kind: "scm" },
  });
  resolveDefaultBranchShaMock.mockReset();
  getRepoMapMock.mockReset();
  enqueueRepoMapWarmJobMock.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/repos/map-status", () => {
  it("401s when unauthenticated", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);
    const res = await GET(getRequest("acme/widgets"));
    expect(res.status).toBe(401);
  });

  it("400s when codebase is missing", async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(400);
  });

  it("reports checkable:false when the sha can't be resolved", async () => {
    resolveDefaultBranchShaMock.mockResolvedValue(undefined);
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: false, checkable: false });
    expect(getRepoMapMock).not.toHaveBeenCalled();
  });

  it("reports checkable:false when no scm connection can see the repo", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: false, checkable: false });
    expect(getRepoMapMock).not.toHaveBeenCalled();
  });

  it("reports mapped:true on a cache hit", async () => {
    resolveDefaultBranchShaMock.mockResolvedValue("deadbeef");
    getRepoMapMock.mockResolvedValue({ content: "the map" });
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: true, checkable: true });
    expect(getRepoMapMock).toHaveBeenCalledWith(3, "acme/widgets", "deadbeef");
  });

  it("reports mapped:false, checkable:true on a cache miss", async () => {
    resolveDefaultBranchShaMock.mockResolvedValue("deadbeef");
    getRepoMapMock.mockResolvedValue(undefined);
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: false, checkable: true });
  });

  it("reports checkable:false rather than throwing when sha resolution rejects", async () => {
    resolveDefaultBranchShaMock.mockRejectedValue(new Error("GitHub API down"));
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: false, checkable: false });
  });

  it("reports checkable:false rather than throwing when resolving the scm connection rejects", async () => {
    resolveScmConnectionMock.mockRejectedValue(new Error("no scm connection"));
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: false, checkable: false });
  });
});

describe("POST /api/repos/map-status", () => {
  it("401s when unauthenticated", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);
    const res = await POST(postRequest({ codebase: "acme/widgets" }));
    expect(res.status).toBe(401);
  });

  it("400s when codebase is missing", async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
  });

  it("triggers the warm job for the org's codebase and returns 204", async () => {
    const res = await POST(postRequest({ codebase: "acme/widgets" }));
    expect(res.status).toBe(204);
    expect(enqueueRepoMapWarmJobMock).toHaveBeenCalledExactlyOnceWith(3, "acme/widgets");
  });

  it("still returns 204 when the queue is down", async () => {
    enqueueRepoMapWarmJobMock.mockRejectedValue(new Error("redis down"));
    const res = await POST(postRequest({ codebase: "acme/widgets" }));
    expect(res.status).toBe(204);
  });
});
