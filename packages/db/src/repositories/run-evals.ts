import { and, desc, eq } from "drizzle-orm";
import type { RunEval, RunEvalResult } from "@agentfactory/core";
import { db } from "../client";
import { runEvals } from "../schema";

function toRunEval(row: typeof runEvals.$inferSelect): RunEval {
  return {
    id: row.id,
    orgId: row.orgId,
    runId: row.runId,
    status: row.status,
    result: row.result ?? undefined,
    judgeModelId: row.judgeModelId ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
  };
}

export async function createRunEval(orgId: number, runId: number): Promise<RunEval> {
  const [row] = await db.insert(runEvals).values({ orgId, runId }).returning();
  return toRunEval(row);
}

export async function getRunEval(id: number): Promise<RunEval | undefined> {
  const [row] = await db.select().from(runEvals).where(eq(runEvals.id, id));
  return row ? toRunEval(row) : undefined;
}

export async function markEvalRunning(id: number): Promise<void> {
  await db.update(runEvals).set({ status: "running" }).where(eq(runEvals.id, id));
}

export async function completeEval(
  id: number,
  result: RunEvalResult,
  judgeModelId: string,
): Promise<RunEval> {
  const [row] = await db
    .update(runEvals)
    .set({ status: "done", result, judgeModelId, completedAt: new Date() })
    .where(eq(runEvals.id, id))
    .returning();
  return toRunEval(row);
}

export async function failEval(id: number, error: string): Promise<RunEval> {
  const [row] = await db
    .update(runEvals)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(eq(runEvals.id, id))
    .returning();
  return toRunEval(row);
}

// Newest first (id as tiebreak — same-millisecond inserts are routine in tests). Org-scoped
// via the denormalized org_id so a caller can never list another tenant's evals.
export async function listEvalsForRun(runId: number, orgId: number): Promise<RunEval[]> {
  const rows = await db
    .select()
    .from(runEvals)
    .where(and(eq(runEvals.runId, runId), eq(runEvals.orgId, orgId)))
    .orderBy(desc(runEvals.createdAt), desc(runEvals.id));
  return rows.map(toRunEval);
}
