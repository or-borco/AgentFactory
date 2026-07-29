import { eq } from "drizzle-orm";
import type { Run, RunStatus } from "@agentfactory/core";
import { db } from "../client";
import { runs } from "../schema";

function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    promptHash: row.promptHash ?? undefined,
    costUsd: row.costUsd,
    tokensUsed: row.tokensUsed,
    budgetExceeded: row.budgetExceeded ?? undefined,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : undefined,
  };
}

export async function createRun(sessionId: number): Promise<Run> {
  const [row] = await db.insert(runs).values({ sessionId }).returning();
  return toRun(row);
}

export async function getRun(id: number): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row ? toRun(row) : undefined;
}

export async function updateRunStatus(
  id: number,
  status: RunStatus,
  patch?: { finishedAt?: Date },
): Promise<Run | undefined> {
  const values: Partial<typeof runs.$inferInsert> = { status };
  if (patch?.finishedAt !== undefined) values.finishedAt = patch.finishedAt;

  const [row] = await db.update(runs).set(values).where(eq(runs.id, id)).returning();
  return row ? toRun(row) : undefined;
}
