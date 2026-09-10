import { and, eq, isNull } from "drizzle-orm";
import type { SkillVersion } from "@agentfactory/core";
import { createBlobStore } from "@agentfactory/storage";
import { db } from "../client";
import { skillVersions } from "../schema";
import { insertContentBlob } from "./content-blobs";

const blobStore = createBlobStore();

export function composeSkillMarkdown(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}`;
}

// Splits a previously-composed SKILL.md back into its three editable fields, for pre-filling the
// "new draft from published" editor. Deliberately tolerant of the exact frontmatter shape this
// module itself writes — not a general YAML/Markdown parser.
export function decomposeSkillMarkdown(markdown: string): { name: string; description: string; instructions: string } {
  const match = markdown.match(/^---\nname: (.*)\ndescription: (.*)\n---\n\n([\s\S]*)$/);
  if (!match) throw new Error("Malformed skill markdown: expected name/description frontmatter");
  const [, name, description, instructions] = match;
  return { name, description, instructions };
}

function toVersion(row: typeof skillVersions.$inferSelect): SkillVersion {
  return {
    id: row.id,
    skillId: row.skillId,
    version: row.version,
    name: row.name,
    description: row.description,
    bodySha256: row.bodySha256,
    createdBy: row.createdBy ?? undefined,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getSkillVersionsForSkill(skillId: number): Promise<SkillVersion[]> {
  const rows = await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .orderBy(skillVersions.version);
  return rows.map(toVersion);
}

export async function getSkillVersion(id: number): Promise<SkillVersion | undefined> {
  const [row] = await db.select().from(skillVersions).where(eq(skillVersions.id, id));
  return row ? toVersion(row) : undefined;
}

export async function getDraftForSkill(skillId: number): Promise<SkillVersion | undefined> {
  const [row] = await db
    .select()
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skillId), isNull(skillVersions.publishedAt)));
  return row ? toVersion(row) : undefined;
}

// Bytes first, then the content_blobs row, then whatever references it — the same order every
// other blob writer in this codebase uses (see apps/web's team/task context-item routes), because
// skill_versions' (org_id, body_sha256) FK means the blob row has to exist before this insert.
async function putBody(orgId: number, markdown: string): Promise<string> {
  const bytes = new TextEncoder().encode(markdown);
  const { sha256, sizeBytes } = await blobStore.put(orgId, bytes, "text/markdown");
  await insertContentBlob(orgId, sha256, sizeBytes, "text/markdown");
  return sha256;
}

export async function getSkillVersionMarkdown(orgId: number, version: SkillVersion): Promise<string | undefined> {
  const bytes = await blobStore.get(orgId, version.bodySha256);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

export async function updateDraft(
  versionId: number,
  orgId: number,
  patch: { name?: string; description?: string; instructions?: string },
): Promise<SkillVersion | undefined> {
  const current = await getSkillVersion(versionId);
  if (!current || current.publishedAt) return undefined; // not a draft (or doesn't exist)

  const existingMarkdown = await getSkillVersionMarkdown(orgId, current);
  const existing = existingMarkdown ? decomposeSkillMarkdown(existingMarkdown) : { name: current.name, description: current.description, instructions: "" };
  const name = patch.name ?? existing.name;
  const description = patch.description ?? current.description;
  const instructions = patch.instructions ?? existing.instructions;

  const bodySha256 = await putBody(orgId, composeSkillMarkdown(name, description, instructions));
  const [row] = await db
    .update(skillVersions)
    .set({ name, description, bodySha256 })
    .where(eq(skillVersions.id, versionId))
    .returning();
  return row ? toVersion(row) : undefined;
}

export async function insertDraftVersion(input: {
  skillId: number;
  orgId: number;
  version: number;
  name: string;
  description: string;
  instructions: string;
  createdBy?: number;
}): Promise<SkillVersion> {
  const bodySha256 = await putBody(input.orgId, composeSkillMarkdown(input.name, input.description, input.instructions));
  const [row] = await db
    .insert(skillVersions)
    .values({
      skillId: input.skillId,
      orgId: input.orgId,
      version: input.version,
      name: input.name,
      description: input.description,
      bodySha256,
      createdBy: input.createdBy,
    })
    .returning();
  return toVersion(row);
}

export async function markPublished(versionId: number): Promise<SkillVersion | undefined> {
  const [row] = await db
    .update(skillVersions)
    .set({ publishedAt: new Date() })
    .where(eq(skillVersions.id, versionId))
    .returning();
  return row ? toVersion(row) : undefined;
}
