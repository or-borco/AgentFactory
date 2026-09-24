import { MAX_MEMORY_CONTENT_CHARS, type MemorySource } from "@agentfactory/core";
import { findSimilarMemoryEntry, insertMemoryEntryWithWrite, reinforceMemoryEntryWithWrite } from "@agentfactory/db";
import { getEmbedder, type Embedder } from "./embedder";

// A much higher bar than SIMILARITY_FLOOR (0.6, document retrieval): a false-positive merge here
// silently discards a distinct new lesson rather than merely missing a relevant excerpt. Tunable,
// not user-facing, revisit with real data the same way the retrieval floor was.
export const MEMORY_SIMILARITY_FLOOR = 0.85;

// Re-exported for this module's existing importers (e.g. memory-write.test.ts). The value now
// lives in @agentfactory/core so apps/web's PATCH .../memory/[entryId] route can enforce the same
// cap without depending on apps/worker.
export { MAX_MEMORY_CONTENT_CHARS };

export interface MemoryProvenance {
  runId?: number;
  sessionId?: number;
}

export interface MemoryWriteOptions {
  reason?: string;
}

export interface MemoryWriteDeps {
  findSimilarMemoryEntry: typeof findSimilarMemoryEntry;
  insertMemoryEntryWithWrite: typeof insertMemoryEntryWithWrite;
  reinforceMemoryEntryWithWrite: typeof reinforceMemoryEntryWithWrite;
  embedder: Embedder;
}

const defaultDbDeps: Omit<MemoryWriteDeps, "embedder"> = {
  findSimilarMemoryEntry,
  insertMemoryEntryWithWrite,
  reinforceMemoryEntryWithWrite,
};

function capContent(content: string): string {
  return content.length > MAX_MEMORY_CONTENT_CHARS ? content.slice(0, MAX_MEMORY_CONTENT_CHARS) : content;
}

export async function writeMemoryEntry(
  orgId: number,
  agentId: number,
  content: string,
  source: MemorySource,
  provenance: MemoryProvenance,
  options: MemoryWriteOptions = {},
  deps: Partial<MemoryWriteDeps> = {},
): Promise<{ reinforced: boolean }> {
  const d = { ...defaultDbDeps, ...deps };
  const embedder = d.embedder ?? getEmbedder();
  const capped = capContent(content);
  const write = { source, lesson: capped, reason: options.reason, runId: provenance.runId, sessionId: provenance.sessionId };

  const [embedding] = await embedder.embedDocuments([capped]);
  const match = await d.findSimilarMemoryEntry(orgId, agentId, embedding, MEMORY_SIMILARITY_FLOOR);

  if (match) {
    await d.reinforceMemoryEntryWithWrite(orgId, agentId, match.id, write);
    return { reinforced: true };
  }

  await d.insertMemoryEntryWithWrite(
    { orgId, agentId, source, content: capped, embedding, embeddingModel: embedder.modelId },
    write,
  );
  return { reinforced: false };
}
