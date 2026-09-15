import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";

vi.mock("@/server/auth", () => ({ requireAuthContext: vi.fn(async () => ({ orgId: 1 })) }));
const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
vi.mock("@agentfactory/db", () => ({ listConnections: (orgId: number) => listConnectionsMock(orgId) }));
const getScmProviderMock = vi.fn();
vi.mock("@agentfactory/scm", () => ({ getScmProvider: (id: string) => getScmProviderMock(id) }));

const { GET } = await import("../route");

function connection(id: number, provider: string): Connection {
  return {
    id,
    orgId: 1,
    provider: provider as never,
    kind: "scm",
    label: provider,
    health: "healthy",
    config: {},
    auth: "none",
    createdAt: new Date().toISOString(),
  };
}

afterEach(() => {
  listConnectionsMock.mockReset();
  getScmProviderMock.mockReset();
});

describe("GET /api/connections/repos", () => {
  it("aggregates repos from every scm connection and tags each with its provider", async () => {
    listConnectionsMock.mockResolvedValue([connection(1, "github"), connection(2, "bitbucket")]);
    getScmProviderMock.mockImplementation((id: string) => ({
      listRepos: async () =>
        id === "github" ? [{ id: "1", fullName: "acme/platform" }] : [{ id: "2", fullName: "acme/site" }],
    }));

    const res = await GET();
    await expect(res.json()).resolves.toEqual([
      { id: "1", fullName: "acme/platform", provider: "github" },
      { id: "2", fullName: "acme/site", provider: "bitbucket" },
    ]);
  });

  it("skips connections with no registered provider", async () => {
    listConnectionsMock.mockResolvedValue([connection(1, "asana")]);
    getScmProviderMock.mockReturnValue(undefined);

    const res = await GET();
    await expect(res.json()).resolves.toEqual([]);
  });

  it("skips a connection whose listRepos call throws, without failing the whole request", async () => {
    listConnectionsMock.mockResolvedValue([connection(1, "github"), connection(2, "github")]);
    getScmProviderMock.mockReturnValue({
      listRepos: vi
        .fn()
        .mockRejectedValueOnce(new Error("revoked"))
        .mockResolvedValueOnce([{ id: "1", fullName: "acme/platform" }]),
    });

    const res = await GET();
    await expect(res.json()).resolves.toEqual([{ id: "1", fullName: "acme/platform", provider: "github" }]);
  });

  it("dedupes repos that appear via more than one connection of the same provider", async () => {
    listConnectionsMock.mockResolvedValue([connection(1, "github"), connection(2, "github")]);
    getScmProviderMock.mockReturnValue({ listRepos: async () => [{ id: "1", fullName: "acme/platform" }] });

    const res = await GET();
    await expect(res.json()).resolves.toEqual([{ id: "1", fullName: "acme/platform", provider: "github" }]);
  });

  it("returns 401 when unauthenticated", async () => {
    const { requireAuthContext } = await import("@/server/auth");
    vi.mocked(requireAuthContext).mockResolvedValueOnce(undefined as never);

    const res = await GET();
    expect(res.status).toBe(401);
  });
});
