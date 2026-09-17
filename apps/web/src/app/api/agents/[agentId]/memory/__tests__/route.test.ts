import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContext = vi.fn();
const getAgent = vi.fn();
const readAgentMemoryEntries = vi.fn();

vi.mock("@agentfactory/db", () => ({
  getAgent: (...args: unknown[]) => getAgent(...args),
  readAgentMemoryEntries: (...args: unknown[]) => readAgentMemoryEntries(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { GET } from "../route";

function get(agentId: string) {
  return GET(new Request(`http://localhost/api/agents/${agentId}/memory`), { params: Promise.resolve({ agentId }) });
}

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  getAgent.mockReset();
  readAgentMemoryEntries.mockReset();
});

describe("GET /api/agents/[agentId]/memory", () => {
  it("401s without touching the db", async () => {
    requireAuthContext.mockResolvedValue(undefined);

    const res = await get("5");

    expect(res.status).toBe(401);
    expect(readAgentMemoryEntries).not.toHaveBeenCalled();
  });

  it("404s when the agent belongs to another org", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 999 });

    const res = await get("5");

    expect(res.status).toBe(404);
    expect(readAgentMemoryEntries).not.toHaveBeenCalled();
  });

  it("404s when the agent doesn't exist", async () => {
    getAgent.mockResolvedValue(undefined);

    const res = await get("5");

    expect(res.status).toBe(404);
  });

  it("returns the decrypted entries for the agent's own org", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });
    readAgentMemoryEntries.mockResolvedValue([
      { id: 1, agentId: 5, orgId: 3, source: "manual", weight: 1, content: "Lesson one." },
    ]);

    const res = await get("5");

    expect(res.status).toBe(200);
    expect(readAgentMemoryEntries).toHaveBeenCalledExactlyOnceWith(3, 5);
    await expect(res.json()).resolves.toMatchObject([{ content: "Lesson one." }]);
  });
});
