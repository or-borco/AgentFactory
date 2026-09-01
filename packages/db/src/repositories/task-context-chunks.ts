import { asc, cosineDistance, count, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { taskContextChunks, taskContextItems } from "../schema";

export interface NewTaskContextChunk {
  itemId: number;
  taskId: number;
  chunkIdx: number;
  text: string;
  // Length must match the column's vector(384) or Postgres rejects the whole batch. The width
  // is asserted in the worker's embedder, where the model that produced it is in scope.
  embedding: number[];
  embeddingModel: string;
}

// Guards the empty batch because drizzle throws on `.values([])` — and an empty batch is a
// normal outcome, not a bug: an empty or whitespace-only document chunks to nothing. Mirrors
// insertTeamContextChunks.
export async function insertTaskContextChunks(rows: NewTaskContextChunk[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(taskContextChunks).values(rows);
}

// Called before every re-insert, which is what makes an ingest job idempotent under BullMQ's
// stalled-job redelivery: re-running produces the same rows, never a doubled corpus. Mirrors
// deleteTeamChunksForItem.
export async function deleteTaskChunksForItem(itemId: number): Promise<void> {
  await db.delete(taskContextChunks).where(eq(taskContextChunks.itemId, itemId));
}

export async function countChunksForTaskItem(itemId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(taskContextChunks)
    .where(eq(taskContextChunks.itemId, itemId));
  return row.value;
}

export interface TaskContextChunkMatch {
  id: number;
  itemId: number;
  itemTitle: string;
  chunkIdx: number;
  text: string;
  // Cosine similarity in [-1, 1] — 1 - distance. The caller compares it against a floor, so it
  // is reported as similarity rather than distance to keep "higher is better" unambiguous.
  score: number;
}

// Mirrors searchTeamContextChunks exactly, keyed by task_id instead of team_id — see that
// function's comment for why the transaction, the `set local hnsw.iterative_scan`, and the
// outer re-sort all exist; none of that reasoning changes for the task-scoped table.
export async function searchTaskContextChunks(
  taskId: number,
  embedding: number[],
  limit: number,
): Promise<TaskContextChunkMatch[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.iterative_scan = 'relaxed_order'`);

    const distance = cosineDistance(taskContextChunks.embedding, embedding);
    const topK = tx
      .select({
        id: taskContextChunks.id,
        itemId: taskContextChunks.itemId,
        chunkIdx: taskContextChunks.chunkIdx,
        text: taskContextChunks.text,
        distance: sql<number>`${distance}`.as("distance"),
      })
      .from(taskContextChunks)
      .where(eq(taskContextChunks.taskId, taskId))
      .orderBy(distance)
      .limit(limit)
      .as("top_k");

    const rows = await tx
      .select({
        id: topK.id,
        itemId: topK.itemId,
        itemTitle: taskContextItems.title,
        chunkIdx: topK.chunkIdx,
        text: topK.text,
        distance: topK.distance,
      })
      .from(topK)
      .innerJoin(taskContextItems, eq(topK.itemId, taskContextItems.id))
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
