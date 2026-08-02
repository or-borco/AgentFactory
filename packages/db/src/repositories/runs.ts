import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { Run, RunStatus } from "@agentfactory/core";
import { db } from "../client";
import { runs } from "../schema";

function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    triggeringMessageId: row.triggeringMessageId ?? undefined,
    providerSessionRef: row.providerSessionRef ?? undefined,
    promptHash: row.promptHash ?? undefined,
    costUsd: row.costUsd,
    tokensUsed: row.tokensUsed,
    budgetExceeded: row.budgetExceeded ?? undefined,
    workspaceSnapshot: (row.workspaceSnapshot as Record<string, string>) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : undefined,
  };
}

export async function getRunsForSession(sessionId: number): Promise<Run[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(eq(runs.sessionId, sessionId))
    .orderBy(desc(runs.createdAt));
  return rows.map(toRun);
}

export async function updateRunWorkspace(
  id: number,
  workspaceSnapshot: Record<string, string>,
): Promise<void> {
  await db.update(runs).set({ workspaceSnapshot }).where(eq(runs.id, id));
}

export async function createRun(sessionId: number, triggeringMessageId?: number): Promise<Run> {
  const [row] = await db.insert(runs).values({ sessionId, triggeringMessageId }).returning();
  return toRun(row);
}

export async function getRun(id: number): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row ? toRun(row) : undefined;
}

export async function updateRunStatus(
  id: number,
  status: RunStatus,
  patch?: { finishedAt?: Date; providerSessionRef?: string },
): Promise<Run | undefined> {
  const values: Partial<typeof runs.$inferInsert> = { status };
  if (patch?.finishedAt !== undefined) values.finishedAt = patch.finishedAt;
  if (patch?.providerSessionRef !== undefined) values.providerSessionRef = patch.providerSessionRef;

  const [row] = await db.update(runs).set(values).where(eq(runs.id, id)).returning();
  return row ? toRun(row) : undefined;
}

// Finds the provider session to resume from: the most recent other run on this
// session that actually completed a provider turn. Postgres stays the source of
// truth for "what should this run resume from" — per ARCHITECTURE.md §1 rule 3,
// provider session refs live on runs, never carried in queue/business logic.
export async function getLatestProviderSessionRef(
  sessionId: number,
  excludeRunId: number,
): Promise<string | undefined> {
  const [row] = await db
    .select({ providerSessionRef: runs.providerSessionRef })
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), ne(runs.id, excludeRunId), isNotNull(runs.providerSessionRef)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row?.providerSessionRef ?? undefined;
}
