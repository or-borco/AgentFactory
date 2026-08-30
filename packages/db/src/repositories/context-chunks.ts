import { count, eq } from "drizzle-orm";
import { db } from "../client";
import { contextChunks } from "../schema";

export interface NewContextChunk {
  itemId: number;
  teamId: number;
  chunkIdx: number;
  text: string;
  // Length must match the column's vector(384) or Postgres rejects the whole batch. The width
  // is asserted in the worker's embedder, where the model that produced it is in scope.
  embedding: number[];
  embeddingModel: string;
}

// Guards the empty batch because drizzle throws on `.values([])` — and an empty batch is a
// normal outcome, not a bug: an empty or whitespace-only document chunks to nothing.
export async function insertContextChunks(rows: NewContextChunk[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(contextChunks).values(rows);
}

// Called before every re-insert, which is what makes an ingest job idempotent under BullMQ's
// stalled-job redelivery: re-running produces the same rows, never a doubled corpus.
export async function deleteChunksForItem(itemId: number): Promise<void> {
  await db.delete(contextChunks).where(eq(contextChunks.itemId, itemId));
}

export async function countChunksForItem(itemId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(contextChunks)
    .where(eq(contextChunks.itemId, itemId));
  return row.value;
}
