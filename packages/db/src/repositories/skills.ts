import { and, eq } from "drizzle-orm";
import type { Skill, SkillVersion } from "@agentfactory/core";
import { db } from "../client";
import { agentSkills, skills } from "../schema";
import { getDraftForSkill, getSkillVersionsForSkill, insertDraftVersion, markPublished } from "./skill-versions";

function toSkill(row: typeof skills.$inferSelect): Skill {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    source: row.source as Skill["source"],
    currentVersionId: row.currentVersionId ?? undefined,
    family: row.family ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function listSkillsForOrg(orgId: number): Promise<Skill[]> {
  const rows = await db.select().from(skills).where(eq(skills.orgId, orgId)).orderBy(skills.createdAt);
  return rows.map(toSkill);
}

export async function getSkillForOrg(id: number, orgId: number): Promise<Skill | undefined> {
  const [row] = await db.select().from(skills).where(and(eq(skills.id, id), eq(skills.orgId, orgId)));
  return row ? toSkill(row) : undefined;
}

export async function createSkillWithDraft(
  orgId: number,
  input: { name: string; description: string; instructions: string; createdBy?: number },
): Promise<{ skill: Skill; draft: SkillVersion }> {
  const [row] = await db
    .insert(skills)
    .values({ orgId, name: input.name, slug: slugify(input.name), description: "", createdBy: input.createdBy })
    .returning();
  const draft = await insertDraftVersion({
    skillId: row.id,
    orgId,
    version: 1,
    // The version's name is a display name, not the directory-safe slug (that's `skills.slug`,
    // used by Task 5's materialize step) — it must survive round-tripping through the composed
    // SKILL.md frontmatter untouched, or the draft you just typed "Foo" into comes back "foo".
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    createdBy: input.createdBy,
  });
  return { skill: toSkill(row), draft };
}

export async function createDraftFromPublished(
  skillId: number,
  orgId: number,
  createdBy?: number,
): Promise<SkillVersion | undefined> {
  const existingDraft = await getDraftForSkill(skillId);
  if (existingDraft) return undefined; // 409 — caller decides the HTTP status

  const versions = await getSkillVersionsForSkill(skillId);
  const published = versions.filter((v) => v.publishedAt).sort((a, b) => b.version - a.version)[0];
  if (!published) return undefined; // nothing to branch from

  return insertDraftVersion({
    skillId,
    orgId,
    version: published.version + 1,
    name: published.name,
    description: published.description,
    instructions: "", // caller (route) re-fetches the published markdown and re-composes if it wants to seed the body; see Task 3
    createdBy,
  });
}

export async function publishDraft(
  skillId: number,
  orgId: number,
  versionId: number,
): Promise<{ skill: Skill; version: SkillVersion } | undefined> {
  const version = await markPublished(versionId);
  if (!version) return undefined;
  const [row] = await db
    .update(skills)
    .set({ currentVersionId: version.id, name: version.name, description: version.description, updatedAt: new Date() })
    .where(and(eq(skills.id, skillId), eq(skills.orgId, orgId)))
    .returning();
  return row ? { skill: toSkill(row), version } : undefined;
}

// false, not a throw: the route turns this into a 409. A skill referenced by at least one
// agent_skills row must be unassigned first — deleting it out from under a run would silently
// break that agent's next materialize step.
export async function deleteSkillForOrg(id: number, orgId: number): Promise<boolean> {
  const [assignment] = await db.select().from(agentSkills).where(eq(agentSkills.skillId, id));
  if (assignment) return false;
  const rows = await db.delete(skills).where(and(eq(skills.id, id), eq(skills.orgId, orgId))).returning({ id: skills.id });
  return rows.length > 0;
}
