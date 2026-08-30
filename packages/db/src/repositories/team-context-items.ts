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
