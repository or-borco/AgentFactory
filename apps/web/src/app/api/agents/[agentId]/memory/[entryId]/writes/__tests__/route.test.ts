import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContext = vi.fn();
const getAgent = vi.fn();
const memoryEntryBelongsToAgent = vi.fn();
const listMemoryEntryWrites = vi.fn();

vi.mock("@agentfactory/db", () => ({
  getAgent: (...args: unknown[]) => getAgent(...args),
  memoryEntryBelongsToAgent: (...args: unknown[]) => memoryEntryBelongsToAgent(...args),
  listMemoryEntryWrites: (...args: unknown[]) => listMemoryEntryWrites(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { GET } from "../route";

function get(agentId: string, entryId: string) {
  return GET(new Request(`http://localhost/api/agents/${agentId}/memory/${entryId}/writes`), {
    params: Promise.resolve({ agentId, entryId }),
  });
}

const WRITES = [
  { id: 2, kind: "reinforce", source: "manual", createdAt: "2026-09-23T10:00:00.000Z", lesson: "Use pnpm.", session: { id: 71 } },
  { id: 1, kind: "insert", source: "retrospective", createdAt: "2026-09-22T10:00:00.000Z", decryptError: true },
];

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  getAgent.mockReset().mockResolvedValue({ id: 5, orgId: 3 });
  memoryEntryBelongsToAgent.mockReset().mockResolvedValue(true);
  listMemoryEntryWrites.mockReset().mockResolvedValue(WRITES);
});

describe("GET /api/agents/[agentId]/memory/[entryId]/writes", () => {
  it("401s without touching the db", async () => {
    requireAuthContext.mockResolvedValue(undefined);

    const res = await get("5", "1");

    expect(res.status).toBe(401);
    expect(listMemoryEntryWrites).not.toHaveBeenCalled();
  });

  it("404s when the agent belongs to another org", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 999 });

    const res = await get("5", "1");

    expect(res.status).toBe(404);
    expect(listMemoryEntryWrites).not.toHaveBeenCalled();
  });

  it("404s when the entry belongs to a different agent", async () => {
    memoryEntryBelongsToAgent.mockResolvedValue(false);

    const res = await get("5", "1");

    expect(res.status).toBe(404);
    expect(memoryEntryBelongsToAgent).toHaveBeenCalledWith(3, 5, 1);
    expect(listMemoryEntryWrites).not.toHaveBeenCalled();
  });

  it("returns the entry's writes as the repository ordered them", async () => {
    const res = await get("5", "1");

    expect(res.status).toBe(200);
    expect(listMemoryEntryWrites).toHaveBeenCalledExactlyOnceWith(3, 1);
    expect(await res.json()).toEqual(WRITES);
  });
});
