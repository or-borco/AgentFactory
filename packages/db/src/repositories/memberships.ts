import { asc, eq, and } from "drizzle-orm";
import type { Membership, OrgMember } from "@agentfactory/core";
import { db } from "../client";
import { memberships, users } from "../schema";

function toMembership(row: typeof memberships.$inferSelect): Membership {
  return { orgId: row.orgId, userId: row.userId, role: row.role };
}

export async function createMembership(input: Membership): Promise<Membership> {
  const [row] = await db.insert(memberships).values(input).returning();
  return toMembership(row);
}

export async function listOrgMembers(orgId: number): Promise<OrgMember[]> {
  const rows = await db
    .select({
      userId: memberships.userId,
      orgId: memberships.orgId,
      role: memberships.role,
      joinedAt: memberships.createdAt,
      email: users.email,
      name: users.name,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(memberships.createdAt));
  return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
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

// The fallback createdBy attribution for a Telegram-created task when no invite-code redeemer row
// can be found (see getInviteCodeRedeemer) — every org gets exactly one "owner" membership at
// registration (apps/web/src/app/api/auth/register/route.ts), so this should always resolve in
// practice; it exists as a defensive second lookup, not the primary path.
export async function getOrgOwnerUserId(orgId: number): Promise<number | undefined> {
  const [row] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner")))
    .orderBy(asc(memberships.createdAt))
    .limit(1);
  return row?.userId;
}
