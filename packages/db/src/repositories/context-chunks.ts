import { asc, cosineDistance, count, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { contextChunks, teamContextItems } from "../schema";

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

export interface ContextChunkMatch {
  id: number;
  itemId: number;
  itemTitle: string;
  chunkIdx: number;
  text: string;
  // Cosine similarity in [-1, 1] — 1 - distance. The caller compares it against a floor, so it
  // is reported as similarity rather than distance to keep "higher is better" unambiguous.
  score: number;
}

// THE FIRST TRANSACTION IN THIS REPO, and it is load-bearing, not stylistic.
//
// `set local hnsw.iterative_scan = 'relaxed_order'` is what makes a tenant-filtered top-k
// return k rows. HNSW yields ~hnsw.ef_search (default 40) candidates GLOBALLY and the team_id
// predicate is applied to them afterwards; measured on a realistic table, this exact query
// shape returned 4 rows for a limit of 10, with "Rows Removed by Filter: 36" — silently, with
// no error anywhere. iterative_scan keeps scanning until the filter is satisfied.
//
// It must be SET LOCAL, and SET LOCAL requires a transaction: client.ts exports a pooled
// postgres() client with no `max`, so a bare SET would land on an arbitrary pooled connection
// and change the behaviour of unrelated queries for the life of the process.
//
// relaxed_order trades exact ordering for that recall, so the top-k select is wrapped in a
// subquery and re-sorted in an outer ORDER BY — otherwise the `rank` persisted in
// run_context_retrievals would not be reproducible. The title join is deliberately OUTSIDE the
// limited scan: joining inside it risks a plan that does not use the index at all.
export async function searchContextChunks(
  teamId: number,
  embedding: number[],
  limit: number,
): Promise<ContextChunkMatch[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.iterative_scan = 'relaxed_order'`);

    const distance = cosineDistance(contextChunks.embedding, embedding);
    const topK = tx
      .select({
        id: contextChunks.id,
        itemId: contextChunks.itemId,
        chunkIdx: contextChunks.chunkIdx,
        text: contextChunks.text,
        distance: sql<number>`${distance}`.as("distance"),
      })
      .from(contextChunks)
      .where(eq(contextChunks.teamId, teamId))
      .orderBy(distance)
      .limit(limit)
      .as("top_k");

    const rows = await tx
      .select({
        id: topK.id,
        itemId: topK.itemId,
        itemTitle: teamContextItems.title,
        chunkIdx: topK.chunkIdx,
        text: topK.text,
        distance: topK.distance,
      })
      .from(topK)
      .innerJoin(teamContextItems, eq(topK.itemId, teamContextItems.id))
      .orderBy(asc(topK.distance));

    return rows.map((row) => ({
      id: row.id,
      itemId: row.itemId,
      itemTitle: row.itemTitle,
      chunkIdx: row.chunkIdx,
      text: row.text,
      score: 1 - Number(row.distance),
    }));
  });
}
