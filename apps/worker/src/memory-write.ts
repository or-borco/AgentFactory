import type { MemorySource } from "@agentfactory/core";
import { findSimilarMemoryEntry, insertMemoryEntry, reinforceMemoryEntry } from "@agentfactory/db";
import { getEmbedder, type Embedder } from "./embedder";

// A much higher bar than SIMILARITY_FLOOR (0.6, document retrieval): a false-positive merge here
// silently discards a distinct new lesson rather than merely missing a relevant excerpt. Tunable,
// not user-facing -- revisit with real data the same way the retrieval floor was.
export const MEMORY_SIMILARITY_FLOOR = 0.85;

// A `remember` call or a retrospective lesson should be a concise nudge, not a transcript dump.
// Enforced once, here, rather than as a convention duplicated at each of the two call sites.
export const MAX_MEMORY_CONTENT_CHARS = 2000;

export interface MemoryProvenance {
  runId?: number;
  sessionId?: number;
}

// Narrow function types rather than typeof imports so unit tests can stub each seam with a plain
// vi.fn() -- the production defaults are structurally compatible. Same shape as IngestDeps
// (context-ingest.ts) and EvalRunnerDeps (eval-runner.ts).
export interface MemoryWriteDeps {
  findSimilarMemoryEntry: typeof findSimilarMemoryEntry;
  insertMemoryEntry: typeof insertMemoryEntry;
  reinforceMemoryEntry: typeof reinforceMemoryEntry;
  embedder: Embedder;
}

const defaultDbDeps: Omit<MemoryWriteDeps, "embedder"> = {
  findSimilarMemoryEntry,
  insertMemoryEntry,
  reinforceMemoryEntry,
};

function capContent(content: string): string {
  return content.length > MAX_MEMORY_CONTENT_CHARS ? content.slice(0, MAX_MEMORY_CONTENT_CHARS) : content;
}

// The shared write path both capture pipelines (the `remember` SDK tool, via worker.ts's onEvent
// handler, and the memory-retrospective job) call. Embeds via embedDocuments -- not embedQuery --
// because both sides of the similarity comparison are the same kind of text (a stored lesson vs.
// a candidate lesson), unlike the asymmetric query-against-documents case context-retrieval.ts
// handles; bge-*'s query instruction prefix would be wrong here.
export async function writeMemoryEntry(
  orgId: number,
  agentId: number,
  content: string,
  source: MemorySource,
  provenance: MemoryProvenance,
  deps: Partial<MemoryWriteDeps> = {},
): Promise<{ reinforced: boolean }> {
  const d = { ...defaultDbDeps, ...deps };
  const embedder = d.embedder ?? getEmbedder();
  const capped = capContent(content);

  const [embedding] = await embedder.embedDocuments([capped]);
  const match = await d.findSimilarMemoryEntry(orgId, agentId, embedding, MEMORY_SIMILARITY_FLOOR);

  if (match) {
    await d.reinforceMemoryEntry(match.id, provenance);
    return { reinforced: true };
  }

  await d.insertMemoryEntry({
    orgId,
    agentId,
    source,
    content: capped,
    embedding,
    embeddingModel: embedder.modelId,
    lastSourceRunId: provenance.runId,
    lastSourceSessionId: provenance.sessionId,
  });
  return { reinforced: false };
}
