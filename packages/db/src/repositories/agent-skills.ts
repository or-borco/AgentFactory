import { and, eq } from "drizzle-orm";
import type { AgentSkill } from "@agentfactory/core";
import { db } from "../client";
import { agentSkills, agents, skillVersions, skills } from "../schema";

export interface AgentSkillSummary extends AgentSkill {
  skillName: string;
  skillSlug: string;
  version: number;
}

export async function listAgentSkills(agentId: number): Promise<AgentSkillSummary[]> {
  const rows = await db
    .select({
      agentId: agentSkills.agentId,
      skillId: agentSkills.skillId,
      skillVersionId: agentSkills.skillVersionId,
      createdAt: agentSkills.createdAt,
      skillName: skills.name,
      skillSlug: skills.slug,
      version: skillVersions.version,
    })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .innerJoin(skillVersions, eq(agentSkills.skillVersionId, skillVersions.id))
    .where(eq(agentSkills.agentId, agentId));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

// undefined when the skill has no published version yet — the route turns that into a 400.
export async function assignSkillToAgent(agentId: number, skillId: number): Promise<AgentSkill | undefined> {
  const [skill] = await db.select().from(skills).where(eq(skills.id, skillId));
  if (!skill?.currentVersionId) return undefined;
  const [row] = await db
    .insert(agentSkills)
    .values({ agentId, skillId, skillVersionId: skill.currentVersionId })
    .onConflictDoUpdate({ target: [agentSkills.agentId, agentSkills.skillId], set: { skillVersionId: skill.currentVersionId } })
    .returning();
  return { ...row, createdAt: row.createdAt.toISOString() };
}

// undefined if skillVersionId isn't a published version of `skillId` — the route turns that into
// a 400. Checked here (not trusted from the caller) because this is the one place an "upgrade"
// can silently pin an unpublished draft if unchecked.
export async function updateAgentSkillVersion(
  agentId: number,
  skillId: number,
  skillVersionId: number,
): Promise<AgentSkill | undefined> {
  const [version] = await db
    .select()
    .from(skillVersions)
    .where(and(eq(skillVersions.id, skillVersionId), eq(skillVersions.skillId, skillId)));
  if (!version?.publishedAt) return undefined;

  const [row] = await db
    .update(agentSkills)
    .set({ skillVersionId })
    .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)))
    .returning();
  return row ? { ...row, createdAt: row.createdAt.toISOString() } : undefined;
}

export async function unassignSkillFromAgent(agentId: number, skillId: number): Promise<boolean> {
  const rows = await db
    .delete(agentSkills)
    .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skillId)))
    .returning({ agentId: agentSkills.agentId });
  return rows.length > 0;
}

// Reverse lookup for the skill detail page. Both the agent page and the skill page assign/unassign
// pins here; concurrent writes to the same (agent_id, skill_id) row are safe because
// assignSkillToAgent's onConflictDoUpdate makes them resolve as last-write-wins with no corruption
// risk. Only the version-upgrade action (updateAgentSkillVersion) remains agent-page-only.
export async function listSkillAssignments(
  skillId: number,
): Promise<Array<{ agentId: number; agentName: string; skillVersionId: number; version: number }>> {
  const rows = await db
    .select({
      agentId: agentSkills.agentId,
      agentName: agents.name,
      skillVersionId: agentSkills.skillVersionId,
      version: skillVersions.version,
    })
    .from(agentSkills)
    .innerJoin(agents, eq(agentSkills.agentId, agents.id))
    .innerJoin(skillVersions, eq(agentSkills.skillVersionId, skillVersions.id))
    .where(eq(agentSkills.skillId, skillId));
  return rows;
}
