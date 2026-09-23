import { afterEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn(async (): Promise<{ orgId: number } | undefined> => ({ orgId: 1 }));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));
const listCodebaseSettingsMock = vi.fn();
const setCodebaseSetupCommandMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  CODEBASE_SETUP_COMMAND_MAX_CHARS: 4096,
  listCodebaseSettings: (...args: unknown[]) => listCodebaseSettingsMock(...args),
  setCodebaseSetupCommand: (...args: unknown[]) => setCodebaseSetupCommandMock(...args),
}));

const { GET, PUT } = await import("../route");

function put(body: unknown): Request {
  return new Request("http://localhost/api/codebases/settings", { method: "PUT", body: JSON.stringify(body) });
}

afterEach(() => {
  vi.clearAllMocks();
  requireAuthContextMock.mockResolvedValue({ orgId: 1 });
});

describe("GET /api/codebases/settings", () => {
  it("lists the caller's org settings", async () => {
    listCodebaseSettingsMock.mockResolvedValue([{ repoFullName: "acme/widgets", setupCommand: "make deps" }]);

    const res = await GET();

    expect(listCodebaseSettingsMock).toHaveBeenCalledWith(1);
    await expect(res.json()).resolves.toEqual([{ repoFullName: "acme/widgets", setupCommand: "make deps" }]);
  });

  it("rejects an unauthenticated caller", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);
    expect((await GET()).status).toBe(401);
  });
});

describe("PUT /api/codebases/settings", () => {
  it("stores the setup command for the caller's org", async () => {
    setCodebaseSetupCommandMock.mockResolvedValue({ repoFullName: "acme/widgets", setupCommand: "make deps" });

    const res = await PUT(put({ repoFullName: "acme/widgets", setupCommand: "make deps" }));

    expect(res.status).toBe(200);
    expect(setCodebaseSetupCommandMock).toHaveBeenCalledWith(1, "acme/widgets", "make deps");
  });

  it("clears the override when setupCommand is null or omitted", async () => {
    setCodebaseSetupCommandMock.mockResolvedValue({ repoFullName: "acme/widgets", setupCommand: null });

    await PUT(put({ repoFullName: "acme/widgets", setupCommand: null }));
    await PUT(put({ repoFullName: "acme/widgets" }));

    expect(setCodebaseSetupCommandMock).toHaveBeenNthCalledWith(1, 1, "acme/widgets", null);
    expect(setCodebaseSetupCommandMock).toHaveBeenNthCalledWith(2, 1, "acme/widgets", null);
  });

  it.each([
    [{ repoFullName: "not a repo", setupCommand: "x" }],
    [{ repoFullName: "acme/widgets", setupCommand: 42 }],
    [{ repoFullName: "acme/widgets", setupCommand: "x".repeat(4097) }],
  ])("rejects %j", async (body) => {
    const res = await PUT(put(body));
    expect(res.status).toBe(400);
    expect(setCodebaseSetupCommandMock).not.toHaveBeenCalled();
  });
});
