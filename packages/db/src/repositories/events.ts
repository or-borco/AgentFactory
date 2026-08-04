import { eq } from "drizzle-orm";
import { db } from "../client";
import { events, runs } from "../schema";

export async function listEventsForSession(sessionId: number): Promise<Array<{ id: number; runId: number; seq: number; type: string; data: Record<string, unknown>; createdAt: string }>> {
  const rows = await db
    .select({ id: events.id, runId: events.runId, seq: events.seq, type: events.type, data: events.data, createdAt: events.createdAt })
    .from(events)
    .innerJoin(runs, eq(events.runId, runs.id))
    .where(eq(runs.sessionId, sessionId))
    .orderBy(events.runId, events.seq);
  return rows.map((r) => ({ ...r, data: r.data as Record<string, unknown>, createdAt: r.createdAt.toISOString() }));
}

export async function createEvent(
  runId: number,
  seq: number,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({ runId, seq, type, data });
}
