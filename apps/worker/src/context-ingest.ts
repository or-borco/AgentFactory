import type { TaskContextItem, TeamContextItem } from "@agentfactory/core";
import {
  deleteTaskChunksForItem,
  deleteTeamChunksForItem,
  getTaskContextItem,
  getTeamContextItem,
  insertTaskContextChunks,
  insertTeamContextChunks,
  markTaskContextItemFailed,
  markTaskContextItemIndexed,
  markTaskContextItemIndexing,
  markTeamContextItemFailed,
  markTeamContextItemIndexed,
  markTeamContextItemIndexing,
  type NewContextChunk,
  type NewTaskContextChunk,
} from "@agentfactory/db";
import { createBlobStore, type BlobStore } from "@agentfactory/storage";
import { chunkDocument } from "./chunker";
import { getEmbedder, type Embedder } from "./embedder";
import { extractText } from "./text-extract";

// One document's chunks are embedded in slices this size, with an await between them. The
// ingest worker shares a process with the run worker at concurrency 1 (see worker.ts), so a
// 400-chunk handbook embedded in one call would hold the event loop for its entire duration
// and stall whatever run job is waiting behind it. 32 bounds the damage; it is a tradeoff,
// not a fix — if ingest latency starts delaying runs, the answer is a separate process.
export const EMBED_BATCH_SIZE = 32;

// Narrow function types rather than typeof imports so unit tests can stub each seam with a
// plain vi.fn() — the production defaults are structurally compatible. Same shape as
// EvalRunnerDeps in eval-runner.ts.
export interface IngestDeps {
  getTeamContextItem: (id: number) => Promise<TeamContextItem | undefined>;
  markTeamContextItemIndexing: (id: number) => Promise<void>;
  markTeamContextItemIndexed: (id: number) => Promise<void>;
  markTeamContextItemFailed: (id: number, error: string) => Promise<void>;
  deleteTeamChunksForItem: (itemId: number) => Promise<void>;
  insertTeamContextChunks: (rows: NewContextChunk[]) => Promise<void>;
  blobStore: BlobStore;
  embedder: Embedder;
}

// Only the cheap half. blobStore and embedder are resolved per call, below the status guard:
// getEmbedder() loads the model on first use and createBlobStore() reads env, and neither may
// happen at import time — `tsx watch` re-imports this module on every save, and .husky/pre-push
// runs the unit suite with no network policy of its own.
const defaultDbDeps: Omit<IngestDeps, "blobStore" | "embedder"> = {
  getTeamContextItem,
  markTeamContextItemIndexing,
  markTeamContextItemIndexed,
  markTeamContextItemFailed,
  deleteTeamChunksForItem,
  insertTeamContextChunks,
};

// Same shape as IngestDeps, keyed to the task-scoped repository functions instead — see
// ingestTaskContextItem below for why the two handlers are otherwise identical.
export interface TaskIngestDeps {
  getTaskContextItem: (id: number) => Promise<TaskContextItem | undefined>;
  markTaskContextItemIndexing: (id: number) => Promise<void>;
  markTaskContextItemIndexed: (id: number) => Promise<void>;
  markTaskContextItemFailed: (id: number, error: string) => Promise<void>;
  deleteTaskChunksForItem: (itemId: number) => Promise<void>;
  insertTaskContextChunks: (rows: NewTaskContextChunk[]) => Promise<void>;
  blobStore: BlobStore;
  embedder: Embedder;
}

const defaultTaskDbDeps: Omit<TaskIngestDeps, "blobStore" | "embedder"> = {
  getTaskContextItem,
  markTaskContextItemIndexing,
  markTaskContextItemIndexed,
  markTaskContextItemFailed,
  deleteTaskChunksForItem,
  insertTaskContextChunks,
};

// Never rejects, exactly like processEvalJob: every path past the row lookup ends on a terminal
// row, and a thrown error would only earn a BullMQ retry that the status guard then refuses.
// The `attempts: 3` on the queue is for the case this function never got to run its catch at
// all — a crashed worker leaves the row at "indexing", which the guard admits, and the
// delete-before-insert below makes the second pass land on exactly the same rows.
export async function ingestTeamContextItem(itemId: number, deps: Partial<IngestDeps> = {}): Promise<void> {
  const d = { ...defaultDbDeps, ...deps };

  const item = await d.getTeamContextItem(itemId);
  if (!item) {
    // Cascade delete beat the job to it (team or org removed) — nothing to ingest and no row
    // to record a failure on.
    console.error(`Context item ${itemId} not found; dropping job`);
    return;
  }

  // The eval-runner's stalled-redelivery guard, loosened by one state. "indexed" and "failed"
  // are terminal and must stay that way; "indexing" is admitted precisely because a crash
  // mid-job is what leaves a row there, and the redelivery is how it recovers.
  if (item.status !== "pending" && item.status !== "indexing") {
    console.error(`Context item ${itemId} is already ${item.status}; skipping redelivered job`);
    return;
  }

  try {
    await d.markTeamContextItemIndexing(itemId);

    const blobStore = d.blobStore ?? createBlobStore();
    const embedder = d.embedder ?? getEmbedder();

    const bytes = await blobStore.get(item.orgId, item.sha256);
    if (!bytes) throw new Error(`Blob ${item.sha256} is missing from the blob store`);

    const chunks = chunkDocument(item.title, extractText(item.mime, bytes));

    // Idempotency, and the reason a redelivery is safe: this item's previous chunks go before
    // any new one arrives, so a second pass replaces rather than duplicates.
    await d.deleteTeamChunksForItem(itemId);

    for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
      const embeddings = await embedder.embedDocuments(batch.map((c) => c.text));
      await d.insertTeamContextChunks(
        batch.map((c, i) => ({
          itemId,
          // Denormalized from the item so retrieval's tenant filter sits on the indexed table.
          teamId: item.teamId,
          chunkIdx: c.chunkIdx,
          text: c.text,
          embedding: embeddings[i],
          embeddingModel: embedder.modelId,
        })),
      );
    }

    await d.markTeamContextItemIndexed(itemId);
  } catch (err) {
    console.error(`Context item ${itemId} ingest failed:`, err);
    // The message, not the stack: it is rendered verbatim under the document's row in
    // /teams-v2, and it is the only explanation the uploader ever gets.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await d.markTeamContextItemFailed(itemId, message);
    } catch (writeErr) {
      // The failure write itself failed — nothing left to record it on. The row stays at
      // "indexing", which a redelivery will pick up.
      console.error(`Context item ${itemId}: failed to record failure:`, writeErr);
    }
  }
}

// ingestTeamContextItem's exact shape — same status guard, same idempotent-redelivery
// behavior, same never-rejects contract — reading/writing task_context_items/task_context_chunks
// instead. Kept as a sibling function rather than a shared generic: the two dependency-injection
// shapes (IngestDeps vs TaskIngestDeps) are already structurally identical, and a shared
// implementation would need a scope-dispatch parameter threaded through every call site for no
// behavioral benefit — see the design doc's "parallel tables, not a unified schema" rationale.
export async function ingestTaskContextItem(itemId: number, deps: Partial<TaskIngestDeps> = {}): Promise<void> {
  const d = { ...defaultTaskDbDeps, ...deps };

  const item = await d.getTaskContextItem(itemId);
  if (!item) {
    // Cascade delete beat the job to it (task or org removed) — nothing to ingest and no row
    // to record a failure on.
    console.error(`Task context item ${itemId} not found; dropping job`);
    return;
  }

  // The eval-runner's stalled-redelivery guard, loosened by one state. "indexed" and "failed"
  // are terminal and must stay that way; "indexing" is admitted precisely because a crash
  // mid-job is what leaves a row there, and the redelivery is how it recovers.
  if (item.status !== "pending" && item.status !== "indexing") {
    console.error(`Task context item ${itemId} is already ${item.status}; skipping redelivered job`);
    return;
  }

  try {
    await d.markTaskContextItemIndexing(itemId);

    const blobStore = d.blobStore ?? createBlobStore();
    const embedder = d.embedder ?? getEmbedder();

    const bytes = await blobStore.get(item.orgId, item.sha256);
    if (!bytes) throw new Error(`Blob ${item.sha256} is missing from the blob store`);

    const chunks = chunkDocument(item.title, extractText(item.mime, bytes));

    // Idempotency, and the reason a redelivery is safe: this item's previous chunks go before
    // any new one arrives, so a second pass replaces rather than duplicates.
    await d.deleteTaskChunksForItem(itemId);

    for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
      const embeddings = await embedder.embedDocuments(batch.map((c) => c.text));
      await d.insertTaskContextChunks(
        batch.map((c, i) => ({
          itemId,
          // Denormalized from the item so retrieval's tenant filter sits on the indexed table.
          taskId: item.taskId,
          chunkIdx: c.chunkIdx,
          text: c.text,
          embedding: embeddings[i],
          embeddingModel: embedder.modelId,
        })),
      );
    }

    await d.markTaskContextItemIndexed(itemId);
  } catch (err) {
    console.error(`Task context item ${itemId} ingest failed:`, err);
    // The message, not the stack: it is rendered verbatim under the document's row in the
    // task detail page's Context tab, and it is the only explanation the uploader ever gets.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await d.markTaskContextItemFailed(itemId, message);
    } catch (writeErr) {
      // The failure write itself failed — nothing left to record it on. The row stays at
      // "indexing", which a redelivery will pick up.
      console.error(`Task context item ${itemId}: failed to record failure:`, writeErr);
    }
  }
}
