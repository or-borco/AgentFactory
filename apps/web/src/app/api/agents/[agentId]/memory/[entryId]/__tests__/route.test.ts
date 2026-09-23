import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MEMORY_CONTENT_CHARS } from "@agentfactory/core";

const requireAuthContext = vi.fn();
const getAgent = vi.fn();
const updateMemoryEntryContent = vi.fn();
const deleteMemoryEntry = vi.fn();

vi.mock("@agentfactory/db", () => ({
  getAgent: (...args: unknown[]) => getAgent(...args),
  updateMemoryEntryContent: (...args: unknown[]) => updateMemoryEntryContent(...args),
  deleteMemoryEntry: (...args: unknown[]) => deleteMemoryEntry(...args),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));

import { DELETE, PATCH } from "../route";

function patch(agentId: string, entryId: string, body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://localhost/api/agents/${agentId}/memory/${entryId}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ agentId, entryId }) },
  );
}

function del(agentId: string, entryId: string) {
  return DELETE(new Request(`http://localhost/api/agents/${agentId}/memory/${entryId}`, { method: "DELETE" }), {
    params: Promise.resolve({ agentId, entryId }),
  });
}

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  getAgent.mockReset();
  updateMemoryEntryContent.mockReset().mockResolvedValue(undefined);
  deleteMemoryEntry.mockReset().mockResolvedValue(undefined);
});

describe("PATCH /api/agents/[agentId]/memory/[entryId]", () => {
  it("401s without touching the db", async () => {
    requireAuthContext.mockResolvedValue(undefined);

    const res = await patch("5", "1", { content: "New content" });

    expect(res.status).toBe(401);
    expect(updateMemoryEntryContent).not.toHaveBeenCalled();
  });

  it("404s when the agent belongs to another org", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 999 });

    const res = await patch("5", "1", { content: "New content" });

    expect(res.status).toBe(404);
    expect(updateMemoryEntryContent).not.toHaveBeenCalled();
  });

  it("400s when content is missing or empty", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });

    const res = await patch("5", "1", { content: "" });

    expect(res.status).toBe(400);
    expect(updateMemoryEntryContent).not.toHaveBeenCalled();
  });

  it("400s when content exceeds MAX_MEMORY_CONTENT_CHARS", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });

    const res = await patch("5", "1", { content: "x".repeat(MAX_MEMORY_CONTENT_CHARS + 1) });

    expect(res.status).toBe(400);
    expect(updateMemoryEntryContent).not.toHaveBeenCalled();
  });

  it("accepts content exactly at MAX_MEMORY_CONTENT_CHARS", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });

    const res = await patch("5", "1", { content: "x".repeat(MAX_MEMORY_CONTENT_CHARS) });

    expect(res.status).toBe(204);
    expect(updateMemoryEntryContent).toHaveBeenCalledExactlyOnceWith(3, 1, "x".repeat(MAX_MEMORY_CONTENT_CHARS), 1);
  });

  it("updates the entry's content, org-scoped", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });

    const res = await patch("5", "1", { content: "Edited lesson." });

    expect(res.status).toBe(204);
    expect(updateMemoryEntryContent).toHaveBeenCalledExactlyOnceWith(3, 1, "Edited lesson.", 1);
  });
});

describe("DELETE /api/agents/[agentId]/memory/[entryId]", () => {
  it("401s without touching the db", async () => {
    requireAuthContext.mockResolvedValue(undefined);

    const res = await del("5", "1");

    expect(res.status).toBe(401);
    expect(deleteMemoryEntry).not.toHaveBeenCalled();
  });

  it("404s when the agent belongs to another org", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 999 });

    const res = await del("5", "1");

    expect(res.status).toBe(404);
    expect(deleteMemoryEntry).not.toHaveBeenCalled();
  });

  it("deletes the entry, org-scoped", async () => {
    getAgent.mockResolvedValue({ id: 5, orgId: 3 });

    const res = await del("5", "1");

    expect(res.status).toBe(204);
    expect(deleteMemoryEntry).toHaveBeenCalledExactlyOnceWith(3, 1);
  });
});
