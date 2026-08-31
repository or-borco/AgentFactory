import { asc, eq } from "drizzle-orm";
import type { RunContextRetrieval } from "@agentfactory/core";
import { db } from "../client";
import { runContextRetrievals } from "../schema";

export interface NewRunContextRetrieval {
  runId: number;
  itemId: number;
  itemTitle: string;
  chunkIdx: number;
  rank: number;
  score: number;
}

function toRetrieval(row: typeof runContextRetrievals.$inferSelect): RunContextRetrieval {
  return {
    id: row.id,
    runId: row.runId,
    itemId: row.itemId ?? undefined,
    itemTitle: row.itemTitle,
    chunkIdx: row.chunkIdx,
    rank: row.rank,
    score: row.score,
    createdAt: row.createdAt.toISOString(),
  };
}

// Empty is the normal case — most runs retrieve nothing — and drizzle rejects a values([]) call,
// so the guard is the contract, not a convenience.
export async function insertRunContextRetrievals(rows: NewRunContextRetrieval[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(runContextRetrievals).values(rows);
}

// Rank order, because rank is the order the chunks appeared in the prompt.
export async function listRunContextRetrievals(runId: number): Promise<RunContextRetrieval[]> {
  const rows = await db
    .select()
    .from(runContextRetrievals)
    .where(eq(runContextRetrievals.runId, runId))
    .orderBy(asc(runContextRetrievals.rank));
  return rows.map(toRetrieval);
}
