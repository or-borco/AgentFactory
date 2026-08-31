import { and, eq } from "drizzle-orm";
import type { TeamContextItem } from "@agentfactory/core";
import { db } from "../client";
import { teamContextItems } from "../schema";

export interface NewTeamContextItem {
  teamId: number;
  orgId: number;
  title: string;
  sizeBytes: number;
  sha256: string;
  mime: string;
  uploadedBy?: number;
}

function toItem(row: typeof teamContextItems.$inferSelect): TeamContextItem {
  return {
    id: row.id,
    teamId: row.teamId,
    orgId: row.orgId,
    title: row.title,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    mime: row.mime,
    source: row.source,
    status: row.status,
    error: row.error ?? undefined,
    indexedAt: row.indexedAt ? row.indexedAt.toISOString() : undefined,
    uploadedBy: row.uploadedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

// undefined rather than a throw: a duplicate upload is a normal user outcome, and the route
// turns it into a 409. Duplicates are rejected, never deduplicated into a second item.
export async function createTeamContextItem(
  input: NewTeamContextItem,
): Promise<TeamContextItem | undefined> {
  const [row] = await db
    .insert(teamContextItems)
    .values(input)
    .onConflictDoNothing({ target: [teamContextItems.teamId, teamContextItems.sha256] })
    .returning();
  return row ? toItem(row) : undefined;
}

// Org-scoped by the denormalized column, so a caller cannot list another tenant's documents by
// guessing a teamId — the gap the old unscoped listTeamContextItems left open.
export async function listTeamContextItemsForOrg(
  teamId: number,
  orgId: number,
): Promise<TeamContextItem[]> {
  const rows = await db
    .select()
    .from(teamContextItems)
    .where(and(eq(teamContextItems.teamId, teamId), eq(teamContextItems.orgId, orgId)))
    .orderBy(teamContextItems.createdAt, teamContextItems.id);
  return rows.map(toItem);
}

// Unscoped by id — only the ingest worker calls it, from a job it was handed, never from a
// request parameter.
export async function getTeamContextItem(id: number): Promise<TeamContextItem | undefined> {
  const [row] = await db.select().from(teamContextItems).where(eq(teamContextItems.id, id));
  return row ? toItem(row) : undefined;
}

// Same signature and same guarantee as before, now one statement against the denormalized
// org_id instead of a select-then-delete behind an innerJoin(teams, …).
export async function deleteTeamContextItemForOrg(id: number, orgId: number): Promise<boolean> {
  const rows = await db
    .delete(teamContextItems)
    .where(and(eq(teamContextItems.id, id), eq(teamContextItems.orgId, orgId)))
    .returning({ id: teamContextItems.id });
  return rows.length > 0;
}

// The three writes the ingest worker makes. Each is a whole-row status assignment rather than
// a conditional update: the caller has already decided the transition is legal (see the
// pending | indexing guard in apps/worker/src/context-ingest.ts), and putting the same rule
// in two places would let them disagree.

export async function markContextItemIndexing(id: number): Promise<void> {
  // error is cleared on the way in, not on the way out: a redelivered job that succeeds must
  // not leave the previous attempt's message sitting under an "Indexed" badge.
  await db
    .update(teamContextItems)
    .set({ status: "indexing", error: null })
    .where(eq(teamContextItems.id, id));
}

export async function markContextItemIndexed(id: number): Promise<void> {
  await db
    .update(teamContextItems)
    .set({ status: "indexed", error: null, indexedAt: new Date() })
    .where(eq(teamContextItems.id, id));
}

export async function markContextItemFailed(id: number, error: string): Promise<void> {
  // indexedAt is deliberately untouched — it means "the moment this item's chunks became
  // current", and a failed attempt did not produce any.
  await db.update(teamContextItems).set({ status: "failed", error }).where(eq(teamContextItems.id, id));
}
