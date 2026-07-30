import { asc, eq } from "drizzle-orm";
import type { Membership } from "@agentfactory/core";
import { db } from "../client";
import { memberships } from "../schema";

function toMembership(row: typeof memberships.$inferSelect): Membership {
  return { orgId: row.orgId, userId: row.userId, role: row.role };
}

export async function createMembership(input: Membership): Promise<Membership> {
  const [row] = await db.insert(memberships).values(input).returning();
  return toMembership(row);
}

// No org switcher yet — a user's "home" org is the first one they were added to. Revisit once
// a user can belong to (and pick between) several orgs.
export async function getPrimaryMembership(userId: number): Promise<Membership | undefined> {
  const [row] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return row ? toMembership(row) : undefined;
}
