import { and, eq } from "drizzle-orm";
import type { TeamContextItem } from "@agentfactory/core";
import { db } from "../client";
import { teamContextItems, teams } from "../schema";

function toItem(row: typeof teamContextItems.$inferSelect): TeamContextItem {
  return {
    id: row.id,
    teamId: row.teamId,
    title: row.title,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listTeamContextItems(teamId: number): Promise<TeamContextItem[]> {
  const rows = await db
    .select()
    .from(teamContextItems)
    .where(eq(teamContextItems.teamId, teamId))
    .orderBy(teamContextItems.createdAt);
  return rows.map(toItem);
}

export async function createTeamContextItem(
  teamId: number,
  title: string,
  sizeBytes = 0,
): Promise<TeamContextItem> {
  const [row] = await db
    .insert(teamContextItems)
    .values({ teamId, title, sizeBytes })
    .returning();
  return toItem(row);
}

export async function deleteTeamContextItem(id: number): Promise<void> {
  await db.delete(teamContextItems).where(eq(teamContextItems.id, id));
}

export async function deleteTeamContextItemForOrg(id: number, orgId: number): Promise<boolean> {
  const [item] = await db
    .select({ id: teamContextItems.id })
    .from(teamContextItems)
    .innerJoin(teams, eq(teamContextItems.teamId, teams.id))
    .where(and(eq(teamContextItems.id, id), eq(teams.orgId, orgId)));
  if (!item) return false;
  await db.delete(teamContextItems).where(eq(teamContextItems.id, id));
  return true;
}
