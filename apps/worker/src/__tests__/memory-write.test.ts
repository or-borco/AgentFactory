import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "../embedder";

// @agentfactory/db opens a Postgres client in its module body; the unit project has no
// database. Every export the handler binds as a default dep has to exist on the mock.
vi.mock("@agentfactory/db", () => ({
  findSimilarMemoryEntry: vi.fn(),
  insertMemoryEntry: vi.fn(),
  reinforceMemoryEntry: vi.fn(),
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

describe("writeMemoryEntry", () => {
  it("inserts a new entry when no similar entry exists", async () => {
    const findSimilarMemoryEntry = vi.fn().mockResolvedValue(undefined);
    const insertMemoryEntry = vi.fn().mockResolvedValue(42);
    const reinforceMemoryEntry = vi.fn();
    const embedder = fakeEmbedder([1, 0, 0]);

    const result = await writeMemoryEntry(1, 2, "Don't push to main directly.", "manual", { runId: 9, sessionId: 5 }, {
      findSimilarMemoryEntry,
      insertMemoryEntry,
      reinforceMemoryEntry,
      embedder,
    });

    expect(result).toEqual({ reinforced: false });
    expect(embedder.embedDocuments).toHaveBeenCalledWith(["Don't push to main directly."]);
    expect(findSimilarMemoryEntry).toHaveBeenCalledWith(1, 2, [1, 0, 0], MEMORY_SIMILARITY_FLOOR);
    expect(insertMemoryEntry).toHaveBeenCalledWith({
      orgId: 1,
      agentId: 2,
      source: "manual",
      content: "Don't push to main directly.",
      embedding: [1, 0, 0],
      embeddingModel: "fake-model",
      lastSourceRunId: 9,
      lastSourceSessionId: 5,
    });
    expect(reinforceMemoryEntry).not.toHaveBeenCalled();
  });

  it("reinforces an existing entry when a similar one is found", async () => {
    const findSimilarMemoryEntry = vi.fn().mockResolvedValue({ id: 7, weight: 2 });
    const insertMemoryEntry = vi.fn();
    const reinforceMemoryEntry = vi.fn().mockResolvedValue(undefined);
    const embedder = fakeEmbedder();

    const result = await writeMemoryEntry(1, 2, "Same lesson, reworded.", "retrospective", { sessionId: 5 }, {
      findSimilarMemoryEntry,
      insertMemoryEntry,
      reinforceMemoryEntry,
      embedder,
    });

    expect(result).toEqual({ reinforced: true });
    expect(reinforceMemoryEntry).toHaveBeenCalledWith(7, { runId: undefined, sessionId: 5 });
    expect(insertMemoryEntry).not.toHaveBeenCalled();
  });

  it("truncates content over MAX_MEMORY_CONTENT_CHARS before embedding and storing", async () => {
    const longContent = "x".repeat(MAX_MEMORY_CONTENT_CHARS + 500);
    const findSimilarMemoryEntry = vi.fn().mockResolvedValue(undefined);
    const insertMemoryEntry = vi.fn().mockResolvedValue(1);
    const embedder = fakeEmbedder();

    await writeMemoryEntry(1, 2, longContent, "manual", {}, {
      findSimilarMemoryEntry,
      insertMemoryEntry,
      reinforceMemoryEntry: vi.fn(),
      embedder,
    });

    const [[embeddedText]] = (embedder.embedDocuments as ReturnType<typeof vi.fn>).mock.calls;
    expect(embeddedText[0].length).toBeLessThanOrEqual(MAX_MEMORY_CONTENT_CHARS);
    const insertedContent = insertMemoryEntry.mock.calls[0][0].content;
    expect(insertedContent.length).toBeLessThanOrEqual(MAX_MEMORY_CONTENT_CHARS);
  });
});
