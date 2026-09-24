import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "../embedder";

// @agentfactory/db opens a Postgres client in its module body; the unit project has no
// database. Every export the handler binds as a default dep has to exist on the mock.
vi.mock("@agentfactory/db", () => ({
  findSimilarMemoryEntry: vi.fn(),
  insertMemoryEntryWithWrite: vi.fn(),
  reinforceMemoryEntryWithWrite: vi.fn(),
}));

import { MAX_MEMORY_CONTENT_CHARS, MEMORY_SIMILARITY_FLOOR, writeMemoryEntry } from "../memory-write";

function fakeEmbedder(vector: number[] = [1, 0, 0]): Embedder {
  return {
    modelId: "fake-model",
    dimensions: vector.length,
    embedQuery: vi.fn(async () => vector),
    embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => vector)),
  };
}

function deps(match?: { id: number; weight: number }) {
  return {
    findSimilarMemoryEntry: vi.fn().mockResolvedValue(match),
    insertMemoryEntryWithWrite: vi.fn().mockResolvedValue(42),
    reinforceMemoryEntryWithWrite: vi.fn().mockResolvedValue({ reinforced: true, duplicate: false }),
    embedder: fakeEmbedder(),
  };
}

describe("writeMemoryEntry", () => {
  it("inserts a new entry with its write when no similar entry exists", async () => {
    const d = deps();

    const result = await writeMemoryEntry(1, 2, "Use pnpm.", "manual", { runId: 9, sessionId: 5 }, {}, d);

    expect(result).toEqual({ reinforced: false });
    expect(d.findSimilarMemoryEntry).toHaveBeenCalledWith(1, 2, [1, 0, 0], MEMORY_SIMILARITY_FLOOR);
    expect(d.insertMemoryEntryWithWrite).toHaveBeenCalledExactlyOnceWith(
      { orgId: 1, agentId: 2, source: "manual", content: "Use pnpm.", embedding: [1, 0, 0], embeddingModel: "fake-model" },
      { source: "manual", lesson: "Use pnpm.", reason: undefined, runId: 9, sessionId: 5 },
    );
    expect(d.reinforceMemoryEntryWithWrite).not.toHaveBeenCalled();
  });

  it("reinforces the matched entry, scoped to org and agent, with the proposed text and reason", async () => {
    const d = deps({ id: 7, weight: 1 });

    const result = await writeMemoryEntry(1, 2, "Always use pnpm.", "retrospective", { sessionId: 5 }, { reason: "npm was used twice." }, d);

    expect(result).toEqual({ reinforced: true });
    expect(d.reinforceMemoryEntryWithWrite).toHaveBeenCalledExactlyOnceWith(1, 2, 7, {
      source: "retrospective",
      lesson: "Always use pnpm.",
      reason: "npm was used twice.",
      runId: undefined,
      sessionId: 5,
    });
    expect(d.insertMemoryEntryWithWrite).not.toHaveBeenCalled();
  });

  it("reports reinforced for a same-session duplicate", async () => {
    const d = deps({ id: 7, weight: 2 });
    d.reinforceMemoryEntryWithWrite.mockResolvedValue({ reinforced: false, duplicate: true });

    const result = await writeMemoryEntry(1, 2, "Use pnpm.", "manual", { sessionId: 5 }, {}, d);

    expect(result).toEqual({ reinforced: true });
  });

  it("truncates content over MAX_MEMORY_CONTENT_CHARS before embedding and storing", async () => {
    const d = deps();

    await writeMemoryEntry(1, 2, "x".repeat(MAX_MEMORY_CONTENT_CHARS + 500), "manual", {}, {}, d);

    const [[embeddedText]] = (d.embedder.embedDocuments as ReturnType<typeof vi.fn>).mock.calls;
    expect(embeddedText[0].length).toBeLessThanOrEqual(MAX_MEMORY_CONTENT_CHARS);
    const [entry, write] = d.insertMemoryEntryWithWrite.mock.calls[0];
    expect(entry.content.length).toBeLessThanOrEqual(MAX_MEMORY_CONTENT_CHARS);
    expect(write.lesson).toBe(entry.content);
  });
});
