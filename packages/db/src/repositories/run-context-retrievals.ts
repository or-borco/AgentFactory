import { asc, eq } from "drizzle-orm";
import type { ContextItemKind, RunContextRetrieval } from "@agentfactory/core";
import { db } from "../client";
import { runContextRetrievals } from "../schema";

export interface NewRunContextRetrieval {
  runId: number;
  itemId: number;
  // Optional, not required: this PR has no writer that populates task retrievals yet — every
  // caller today is team-sourced, and the column's own DB default ("team") covers them. A
  // future task-aware retrieveContext (PR 6) passes this explicitly.
  itemKind?: ContextItemKind;
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
    itemKind: row.itemKind,
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
