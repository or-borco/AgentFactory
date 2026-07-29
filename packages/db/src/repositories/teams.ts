import { eq } from "drizzle-orm";
import type { Team } from "@agentfactory/core";
import { db } from "../client";
import { teams } from "../schema";

const MAX_NAME_LENGTH = 80;
const SHARED_CONTEXT_MAX_BYTES = 64 * 1024;

function capName(name: string): string {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}

function capSharedContext(text: string): string {
  return new TextEncoder().encode(text).length > SHARED_CONTEXT_MAX_BYTES
    ? text.slice(0, SHARED_CONTEXT_MAX_BYTES)
    : text;
}

function toTeam(row: typeof teams.$inferSelect): Team {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    description: row.description ?? undefined,
    sharedContext: row.sharedContext,
    githubTeamSlug: row.githubTeamSlug ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listTeams(orgId: number): Promise<Team[]> {
  const rows = await db.select().from(teams).where(eq(teams.orgId, orgId));
  return rows.map(toTeam);
}

export async function getTeam(id: number): Promise<Team | undefined> {
  const [row] = await db.select().from(teams).where(eq(teams.id, id));
  return row ? toTeam(row) : undefined;
}

export async function createTeam(orgId: number, name: string, description: string): Promise<Team> {
  const [row] = await db
    .insert(teams)
    .values({
      orgId,
      name: capName(name),
      description: description || null,
      sharedContext: "",
    })
    .returning();
  return toTeam(row);
}

export async function updateTeam(
  teamId: number,
  patch: { name?: string; description?: string; sharedContext?: string },
): Promise<Team | undefined> {
  const values: Partial<typeof teams.$inferInsert> = {};
  if (patch.name !== undefined) values.name = capName(patch.name);
  if (patch.description !== undefined) values.description = patch.description || null;
  if (patch.sharedContext !== undefined) values.sharedContext = capSharedContext(patch.sharedContext);

  if (Object.keys(values).length === 0) return getTeam(teamId);
  const [row] = await db.update(teams).set(values).where(eq(teams.id, teamId)).returning();
  return row ? toTeam(row) : undefined;
}
