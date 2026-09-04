import { eq } from "drizzle-orm";
import type { User, UserPreferences } from "@agentfactory/core";
import { db } from "../client";
import { users } from "../schema";

function toUser(row: typeof users.$inferSelect): User {
  return { id: row.id, email: row.email, name: row.name, preferences: row.preferences };
}

export async function getUserByEmail(email: string): Promise<(User & { passwordHash: string }) | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row ? { ...toUser(row), passwordHash: row.passwordHash } : undefined;
}

export async function getUserById(id: number): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ? toUser(row) : undefined;
}

export async function createUser(input: { email: string; name: string; passwordHash: string }): Promise<User> {
  const [row] = await db.insert(users).values(input).returning();
  return toUser(row);
}

// Merges `patch` into the user's existing preferences rather than overwriting the whole blob —
// a future second preference key must survive an update that only touches `theme`, and vice
// versa. Read-then-write, not an atomic JSON merge: acceptable for a single-user, low-stakes UI
// setting (see risks in 2026-09-04-user-theme-preference-design.md).
export async function updateUserPreferences(userId: number, patch: Partial<UserPreferences>): Promise<User> {
  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  const merged = { ...(existing?.preferences ?? {}), ...patch };
  const [row] = await db.update(users).set({ preferences: merged }).where(eq(users.id, userId)).returning();
  return toUser(row);
}
