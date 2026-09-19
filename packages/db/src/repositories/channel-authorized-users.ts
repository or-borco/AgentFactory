import { and, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { channelAuthorizedUsers } from "../schema";

export interface AuthorizedUser {
  id: number;
  connectionId: number;
  externalUserId: string;
  authorizedAt: string;
  revokedAt?: string;
  activeTaskId?: number;
}

function toAuthorizedUser(row: typeof channelAuthorizedUsers.$inferSelect): AuthorizedUser {
  return {
    id: row.id,
    connectionId: row.connectionId,
    externalUserId: row.externalUserId,
    authorizedAt: row.authorizedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    activeTaskId: row.activeTaskId ?? undefined,
  };
}

// Insert-or-reactivate: the unique index on (connectionId, externalUserId) makes this a single
// upsert rather than a check-then-branch — a second redemption by the same chat (e.g. after being
// revoked and re-invited) reactivates the same row instead of erroring on the unique constraint.
export async function authorizeExternalUser(connectionId: number, externalUserId: string): Promise<AuthorizedUser> {
  const [row] = await db
    .insert(channelAuthorizedUsers)
    .values({ connectionId, externalUserId })
    .onConflictDoUpdate({
      target: [channelAuthorizedUsers.connectionId, channelAuthorizedUsers.externalUserId],
      set: { revokedAt: null },
    })
    .returning();
  return toAuthorizedUser(row);
}

export async function getAuthorizationStatus(
  connectionId: number,
  externalUserId: string,
): Promise<"authorized" | "revoked" | "unknown"> {
  const [row] = await db
    .select()
    .from(channelAuthorizedUsers)
    .where(and(eq(channelAuthorizedUsers.connectionId, connectionId), eq(channelAuthorizedUsers.externalUserId, externalUserId)));
  if (!row) return "unknown";
  return row.revokedAt ? "revoked" : "authorized";
}

export async function getAuthorizedUser(connectionId: number, externalUserId: string): Promise<AuthorizedUser | undefined> {
  const [row] = await db
    .select()
    .from(channelAuthorizedUsers)
    .where(and(eq(channelAuthorizedUsers.connectionId, connectionId), eq(channelAuthorizedUsers.externalUserId, externalUserId)));
  return row ? toAuthorizedUser(row) : undefined;
}

export async function setActiveTask(connectionId: number, externalUserId: string, taskId: number | null): Promise<void> {
  await db
    .update(channelAuthorizedUsers)
    .set({ activeTaskId: taskId })
    .where(and(eq(channelAuthorizedUsers.connectionId, connectionId), eq(channelAuthorizedUsers.externalUserId, externalUserId)));
}

export async function listAuthorizedUsers(connectionId: number): Promise<AuthorizedUser[]> {
  const rows = await db.select().from(channelAuthorizedUsers).where(eq(channelAuthorizedUsers.connectionId, connectionId));
  return rows.map(toAuthorizedUser);
}

export async function revokeAuthorizedUser(connectionId: number, id: number): Promise<void> {
  await db
    .update(channelAuthorizedUsers)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(channelAuthorizedUsers.connectionId, connectionId), eq(channelAuthorizedUsers.id, id)));
}
