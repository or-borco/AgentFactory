import { and, eq, gt } from "drizzle-orm";
import type { User } from "@agentfactory/core";
import { db } from "../client";
import { authSessions, users } from "../schema";

export async function createAuthSession(input: { tokenHash: string; userId: number; expiresAt: Date }): Promise<void> {
  await db.insert(authSessions).values(input);
}

export async function getUserByTokenHash(tokenHash: string): Promise<User | undefined> {
  const [row] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(and(eq(authSessions.tokenHash, tokenHash), gt(authSessions.expiresAt, new Date())));
  return row;
}

export async function deleteAuthSession(tokenHash: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash));
}
