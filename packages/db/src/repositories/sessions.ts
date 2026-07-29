import { and, eq } from "drizzle-orm";
import type { Session } from "@agentfactory/core";
import { db } from "../client";
import { sessions } from "../schema";

function toSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    origin: row.origin,
    externalThreadRef: row.externalThreadRef ?? undefined,
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

export async function listSessions(orgId: number, agentId?: number): Promise<Session[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(agentId !== undefined ? and(eq(sessions.orgId, orgId), eq(sessions.agentId, agentId)) : eq(sessions.orgId, orgId));
  return rows.map(toSession);
}

export async function getSession(id: number): Promise<Session | undefined> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  return row ? toSession(row) : undefined;
}

export async function createSession(orgId: number, agentId: number, title: string): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({
      orgId,
      agentId,
      title,
      origin: "web",
    })
    .returning();
  return toSession(row);
}

export async function touchSessionActivity(id: number): Promise<void> {
  await db.update(sessions).set({ lastActivityAt: new Date() }).where(eq(sessions.id, id));
}
