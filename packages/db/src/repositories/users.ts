import { eq } from "drizzle-orm";
import type { User } from "@agentfactory/core";
import { db } from "../client";
import { users } from "../schema";

function toUser(row: typeof users.$inferSelect): User {
  return { id: row.id, email: row.email, name: row.name, themePreference: row.themePreference };
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

export async function updateUserThemePreference(
  userId: number,
  themePreference: User["themePreference"],
): Promise<User | undefined> {
  const [row] = await db.update(users).set({ themePreference }).where(eq(users.id, userId)).returning();
  return row ? toUser(row) : undefined;
}
