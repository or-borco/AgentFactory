# Skills Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a centralized Skills library (author + version + publish a Markdown skill), let an Agent pin a specific published version, and have the worker actually load that version into the Claude Agent SDK during a run.

**Architecture:** New `skills`/`skill_versions`/`agent_skills` Postgres tables (replacing `agents.skill_ids`), a content-addressed body stored via the existing `BlobStore`/`content_blobs`, new `/api/skills/**` and `/api/agents/[agentId]/skills/**` routes, new `/skills` UI, and a worker-side materialization step that writes pinned skills into the sandbox's `.claude/skills/` directory before the SDK's `query()` call, passing their names via a new `skills` option.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle ORM / Postgres, Vitest, `@anthropic-ai/claude-agent-sdk`.

**Spec:** `docs/superpowers/specs/2026-09-10-skills-feature-design.md` — read it before starting any task; this plan implements it task-by-task and does not repeat its rationale.

## Global Constraints

- Every new table/column follows the naming and FK conventions already in `packages/db/src/schema.ts` (snake_case columns, `onDelete` specified explicitly, org-scoped via a denormalized `org_id` column where the parent isn't already org-scoped).
- Skill body content is stored exactly as one `SKILL.md` string (YAML frontmatter `name`/`description` + Markdown body) — never split across multiple files or a structured-JSON representation.
- `Agent.skillIds: ID[]` is removed from `packages/core/src/domain.ts` — do not reintroduce it or leave dead references.
- No new prompt segment is added for skills; `apps/worker/src/prompt-composition.ts`'s `composeSystemPrompt` function itself is unchanged (only its stale comment is corrected in Task 5).
- All new repository functions and API routes are org-scoped (never trust a bare id from a route param without checking `orgId`), matching every existing repository in `packages/db/src/repositories/`.
- Run `pnpm typecheck` and the relevant `pnpm --filter <pkg> test` before every commit in every task.

---

### Task 1: Schema, core types, and seed fix

**Files:**
- Modify: `packages/db/src/schema.ts` — add `skills`, `skillVersions`, `agentSkills` tables; remove `skillIds` from the `agents` table.
- Modify: `packages/core/src/domain.ts` — update `Skill`/`SkillVersion`, add `AgentSkill`, remove `Agent.skillIds`.
- Modify: `packages/db/src/repositories/agents.ts` — stop reading/writing `skillIds`.
- Modify: `packages/db/src/seed.ts` — replace the dangling `skillIds: [1]` fixture with real seeded rows.
- Create: `packages/db/drizzle/*.sql` (generated, not hand-written).
- Test: `packages/db/src/__tests__/repositories/agents.test.ts` (adjust any assertion that references `skillIds`).

**Interfaces:**
- Produces (used by Task 2): Drizzle tables `skills`, `skillVersions`, `agentSkills` (exact shapes below), and core types `Skill`, `SkillVersion { id, skillId, version, name, description, bodySha256, createdBy, publishedAt?, createdAt }`, `AgentSkill { agentId, skillId, skillVersionId, createdAt }`.

- [ ] **Step 1: Add the schema tables**

In `packages/db/src/schema.ts`, find the `agents` table definition (`skillIds: jsonb("skill_ids")...` — currently around line 123-126) and delete that line and its two-line comment above it (the comment explaining it's a placeholder).

Add these three new tables after the `contentBlobs` table definition (all imports used below — `sql`, `foreignKey`, `integer`, `pgTable`, `primaryKey`, `text`, `timestamp`, `uniqueIndex` — are already imported at the top of the file):

```ts
export const skills = pgTable(
  "skills",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    source: text("source").notNull().default("authored"),
    currentVersionId: integer("current_version_id"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skills_org_slug").on(t.orgId, t.slug)],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    skillId: integer("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    bodySha256: text("body_sha256").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.bodySha256],
      foreignColumns: [contentBlobs.orgId, contentBlobs.sha256],
    }),
    uniqueIndex("skill_versions_draft_per_skill")
      .on(t.skillId)
      .where(sql`published_at IS NULL`),
  ],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: integer("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: integer("skill_version_id")
      .notNull()
      .references(() => skillVersions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);
```

Note: `skills` and `agents` are defined earlier in the file than `contentBlobs` — since `agentSkills` references `agents.id` and `skills.id`, and `skills`/`skillVersions` reference `contentBlobs`/`orgs`, place all three new tables *after* both `agents` and `contentBlobs` in the file (Drizzle table objects can forward-reference each other via the `() => table` callback form used throughout this file, so exact ordering only matters for readability, not correctness — but keep them together, after `contentBlobs`, for discoverability).

- [ ] **Step 2: Generate and inspect the migration**

Run: `pnpm --filter @agentfactory/db db:generate`
Expected: a new file appears under `packages/db/drizzle/` containing `CREATE TABLE "skills"`, `CREATE TABLE "skill_versions"`, `CREATE TABLE "agent_skills"`, and `ALTER TABLE "agents" DROP COLUMN "skill_ids"`. Open it and confirm those four statements are present — drizzle-kit sometimes needs the `where` clause on `skill_versions_draft_per_skill` fixed up manually if it doesn't emit partial-index syntax correctly; if the generated SQL for that index is missing the `WHERE published_at IS NULL` clause, edit the generated `.sql` file directly to add it before continuing.

- [ ] **Step 3: Update core types**

In `packages/core/src/domain.ts`:

Remove `skillIds: ID[];` from the `Agent` interface.

Replace the existing `Skill`/`SkillVersion` block with:

```ts
export type SkillSource = "authored" | "git";

export interface Skill {
  id: ID;
  orgId: ID;
  name: string;
  slug: string;
  description: string;
  source: SkillSource;
  currentVersionId?: ID;
  createdAt: ISODateTime;
}

export interface SkillVersion {
  id: ID;
  skillId: ID;
  version: number;
  name: string;
  description: string;
  bodySha256: string;
  createdBy?: ID;
  // Absent means this is the unpublished draft — at most one per skill.
  publishedAt?: ISODateTime;
  createdAt: ISODateTime;
}

export interface AgentSkill {
  agentId: ID;
  skillId: ID;
  skillVersionId: ID;
  createdAt: ISODateTime;
}
```

- [ ] **Step 4: Update the agents repository**

In `packages/db/src/repositories/agents.ts`:
- In `toAgent`, delete the line `skillIds: row.skillIds,`.
- In `createAgent`'s `.values({...})`, delete the line `skillIds: [],`.

- [ ] **Step 5: Fix the seed data**

In `packages/db/src/seed.ts`, remove `skillIds: [1]` from the first agent fixture (around line 166) and `skillIds: []` from the other two agent fixtures. After the agents are inserted, add a real skill fixture — find where teams/agents are inserted with explicit ids (look for `.overridingSystemValue()` usage on other tables in this file, e.g. how agents get explicit ids, and follow the same pattern) and insert:
  - one `skills` row (`id: 1, orgId: ORG_ID, name: "Conventional commits", slug: "conventional-commits", description: "Validate and format commit messages against the Conventional Commits spec", source: "authored", currentVersionId: 1`)
  - one `content_blobs` row holding a small `SKILL.md` string (frontmatter `name: conventional-commits` / `description: Validate and format commit messages against the Conventional Commits spec`, body: a short instructions paragraph) — compute its sha256 with `createHash("sha256")` the same way other seed fixtures compute hashes for blob rows (check `content_blobs` seeding elsewhere in this file for the exact pattern; if none exists yet, use `import { createHash } from "node:crypto"` and `createHash("sha256").update(body).digest("hex")`)
  - one `skill_versions` row (`id: 1, skillId: 1, orgId: ORG_ID, version: 1, name: "conventional-commits", description: "...", bodySha256: <the hash above>, publishedAt: new Date()`)
  - one `agent_skills` row (`agentId: 1, skillId: 1, skillVersionId: 1`) pinning it to the first agent, replacing the old `skillIds: [1]`.

- [ ] **Step 6: Run typecheck and existing tests**

Run: `pnpm typecheck`
Expected: no errors referencing `skillIds` anywhere in `apps/web`, `apps/worker`, or `packages/*` (there will be compile errors in files Task 1 doesn't touch yet if any other file reads `agent.skillIds` — grep for `skillIds` across the repo and confirm every remaining reference is inside files this plan's later tasks will touch; if you find one this plan doesn't mention, stop and flag it rather than silently patching around it).

Run: `pnpm --filter @agentfactory/db test`
Expected: `agents.test.ts` passes (fix any assertion there that still checks `skillIds` on a created/updated agent).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle packages/core/src/domain.ts packages/db/src/repositories/agents.ts packages/db/src/seed.ts packages/db/src/__tests__/repositories/agents.test.ts
git commit -m "feat(db): add skills, skill_versions, agent_skills tables

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Skills repositories

**Files:**
- Create: `packages/db/src/repositories/skills.ts`
- Create: `packages/db/src/repositories/skill-versions.ts`
- Create: `packages/db/src/repositories/agent-skills.ts`
- Test: `packages/db/src/__tests__/repositories/skills.test.ts`
- Test: `packages/db/src/__tests__/repositories/agent-skills.test.ts`
- Modify: `packages/db/src/index.ts` (or wherever repository modules are re-exported — check the existing pattern by grepping for `export *` / named exports of `team-context-items` and mirror it) to export the three new modules.

**Interfaces:**
- Consumes: `skills`, `skillVersions`, `agentSkills` tables from Task 1; `Skill`, `SkillVersion`, `AgentSkill` types from Task 1; `insertContentBlob`/`getContentBlob` from `packages/db/src/repositories/content-blobs.ts`.
- Produces (used by Tasks 3, 4, 5):
  - `createSkillWithDraft(orgId, input: { name, description, instructions, createdBy? }): Promise<{ skill: Skill; draft: SkillVersion }>`
  - `listSkillsForOrg(orgId): Promise<Skill[]>`
  - `getSkillForOrg(id, orgId): Promise<Skill | undefined>`
  - `deleteSkillForOrg(id, orgId): Promise<boolean>` (returns `false` if any `agent_skills` row references it, without deleting)
  - `getSkillVersionsForSkill(skillId): Promise<SkillVersion[]>`
  - `getSkillVersion(id): Promise<SkillVersion | undefined>`
  - `getDraftForSkill(skillId): Promise<SkillVersion | undefined>`
  - `updateDraft(versionId, patch: { name?, description?, instructions? }): Promise<SkillVersion | undefined>`
  - `createDraftFromPublished(skillId, orgId, createdBy?): Promise<SkillVersion | undefined>` (409-equivalent: returns `undefined` if a draft already exists)
  - `publishDraft(versionId): Promise<{ skill: Skill; version: SkillVersion } | undefined>`
  - `listAgentSkills(agentId): Promise<Array<AgentSkill & { skillName: string; skillSlug: string; version: number }>>`
  - `listSkillAssignments(skillId): Promise<Array<{ agentId: ID; agentName: string; skillVersionId: ID; version: number }>>` (reverse lookup — which agents have this skill pinned, and at which version; used read-only by Task 3's skill detail page so it doesn't depend on Task 4)
  - `assignSkillToAgent(agentId, skillId): Promise<AgentSkill | undefined>` (pins the skill's current published version; `undefined` if the skill has no published version)
  - `updateAgentSkillVersion(agentId, skillId, skillVersionId): Promise<AgentSkill | undefined>` (only accepts a *published* version of that same skill)
  - `unassignSkillFromAgent(agentId, skillId): Promise<boolean>`

- [ ] **Step 1: Write `skill-versions.ts`**

This module owns blob storage for a version's body (composing/decomposing the `SKILL.md` string) and draft mutation. Frontmatter is simple enough to hand-roll rather than pulling in a YAML library — only two scalar fields, both plain strings with no special YAML characters expected from the editor's inputs (the API route in Task 3 is responsible for rejecting a name/description containing a newline or a `---` line, since that would break this format).

```ts
import { and, eq, isNull } from "drizzle-orm";
import type { SkillVersion } from "@agentfactory/core";
import { createBlobStore } from "@agentfactory/storage";
import { db } from "../client";
import { skillVersions } from "../schema";

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

async function putBody(orgId: number, markdown: string): Promise<string> {
  const { sha256 } = await blobStore.put(orgId, new TextEncoder().encode(markdown), "text/markdown");
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
```

- [ ] **Step 2: Write `skills.ts`**

```ts
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
    createdAt: row.createdAt.toISOString(),
  };
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function listSkillsForOrg(orgId: number): Promise<Skill[]> {
  const rows = await db.select().from(skills).where(eq(skills.orgId, orgId)).orderBy(skills.name);
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
    name: slugify(input.name),
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
```

- [ ] **Step 3: Write `agent-skills.ts`**

```ts
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

// Reverse lookup for the skill detail page (Task 3) — read-only there; unassign/upgrade actions
// live only on the agent page (Task 4), so the two pages never race to mutate the same pin.
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
```

- [ ] **Step 4: Write the repository tests**

`packages/db/src/__tests__/repositories/skills.test.ts` — follow the exact setup pattern in `team-context-items.test.ts` (`import "../setup.js"`, `insertOrg`/`insertUser` fixtures):

```ts
import { describe, expect, it } from "vitest";
import "../setup.js";
import {
  createDraftFromPublished,
  createSkillWithDraft,
  deleteSkillForOrg,
  getSkillForOrg,
  listSkillsForOrg,
  publishDraft,
} from "../../repositories/skills.js";
import { getDraftForSkill, getSkillVersionMarkdown, updateDraft } from "../../repositories/skill-versions.js";
import { assignSkillToAgent } from "../../repositories/agent-skills.js";
import { insertAgent, insertOrg } from "../fixtures.js";

describe("skills repository", () => {
  it("creates a skill with an unpublished draft", async () => {
    const org = await insertOrg();
    const { skill, draft } = await createSkillWithDraft(org.id, {
      name: "Conventional Commits",
      description: "Validate commit messages",
      instructions: "Follow the spec.",
    });
    expect(skill.currentVersionId).toBeUndefined();
    expect(draft.publishedAt).toBeUndefined();
    expect(draft.version).toBe(1);
    await expect(getSkillForOrg(skill.id, org.id)).resolves.toMatchObject({ id: skill.id });
  });

  it("publishing sets currentVersionId and denormalized name/description", async () => {
    const org = await insertOrg();
    const { skill, draft } = await createSkillWithDraft(org.id, {
      name: "Foo", description: "First", instructions: "Body v1",
    });
    const result = await publishDraft(skill.id, org.id, draft.id);
    expect(result?.skill.currentVersionId).toBe(draft.id);
    expect(result?.version.publishedAt).toBeDefined();

    const listed = await listSkillsForOrg(org.id);
    expect(listed.find((s) => s.id === skill.id)?.currentVersionId).toBe(draft.id);
  });

  it("only one draft can exist per skill at a time", async () => {
    const org = await insertOrg();
    const { skill, draft } = await createSkillWithDraft(org.id, {
      name: "Foo", description: "d", instructions: "v1",
    });
    await publishDraft(skill.id, org.id, draft.id);

    const second = await createDraftFromPublished(skill.id, org.id);
    expect(second?.version).toBe(2);

    const blockedThird = await createDraftFromPublished(skill.id, org.id);
    expect(blockedThird).toBeUndefined();
  });

  it("updateDraft rejects a published version", async () => {
    const org = await insertOrg();
    const { skill, draft } = await createSkillWithDraft(org.id, {
      name: "Foo", description: "d", instructions: "v1",
    });
    await publishDraft(skill.id, org.id, draft.id);
    const result = await updateDraft(draft.id, org.id, { instructions: "changed" });
    expect(result).toBeUndefined();
  });

  it("stores and round-trips the composed SKILL.md body", async () => {
    const org = await insertOrg();
    const { draft } = await createSkillWithDraft(org.id, {
      name: "Foo", description: "A skill", instructions: "Do the thing.",
    });
    const markdown = await getSkillVersionMarkdown(org.id, draft);
    expect(markdown).toContain("name: Foo");
    expect(markdown).toContain("description: A skill");
    expect(markdown).toContain("Do the thing.");
  });

  it("deleteSkillForOrg refuses when an agent is assigned", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill, draft } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, draft.id);
    await assignSkillToAgent(agent.id, skill.id);

    await expect(deleteSkillForOrg(skill.id, org.id)).resolves.toBe(false);
    await expect(getSkillForOrg(skill.id, org.id)).resolves.toBeDefined();
  });
});
```

`packages/db/src/__tests__/repositories/agent-skills.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import "../setup.js";
import { assignSkillToAgent, listAgentSkills, listSkillAssignments, unassignSkillFromAgent, updateAgentSkillVersion } from "../../repositories/agent-skills.js";
import { createDraftFromPublished, createSkillWithDraft, publishDraft } from "../../repositories/skills.js";
import { insertAgent, insertOrg } from "../fixtures.js";

describe("agent-skills repository", () => {
  it("assigns the currently published version", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill, draft } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, draft.id);

    const pin = await assignSkillToAgent(agent.id, skill.id);
    expect(pin?.skillVersionId).toBe(draft.id);

    const listed = await listAgentSkills(agent.id);
    expect(listed).toEqual([expect.objectContaining({ skillId: skill.id, version: 1 })]);
  });

  it("refuses to assign a skill with no published version", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await expect(assignSkillToAgent(agent.id, skill.id)).resolves.toBeUndefined();
  });

  it("upgrade pins a newer published version; rejects an unpublished one", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill, draft: v1 } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, v1.id);
    await assignSkillToAgent(agent.id, skill.id);

    const v2 = await createDraftFromPublished(skill.id, org.id);
    if (!v2) throw new Error("expected a second draft");

    await expect(updateAgentSkillVersion(agent.id, skill.id, v2.id)).resolves.toBeUndefined(); // not published yet

    await publishDraft(skill.id, org.id, v2.id);
    const upgraded = await updateAgentSkillVersion(agent.id, skill.id, v2.id);
    expect(upgraded?.skillVersionId).toBe(v2.id);
  });

  it("listSkillAssignments is the reverse lookup by skill", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id, { name: "Reviewer" });
    const { skill, draft } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, draft.id);
    await assignSkillToAgent(agent.id, skill.id);

    const assignments = await listSkillAssignments(skill.id);
    expect(assignments).toEqual([
      expect.objectContaining({ agentId: agent.id, agentName: "Reviewer", version: 1 }),
    ]);
  });

  it("unassign removes the pin", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill, draft } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, draft.id);
    await assignSkillToAgent(agent.id, skill.id);

    await expect(unassignSkillFromAgent(agent.id, skill.id)).resolves.toBe(true);
    await expect(listAgentSkills(agent.id)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @agentfactory/db test`
Expected: all new tests pass; fix any import/signature mismatch against Step 1-3's code before moving on (this plan's function bodies above are the reference implementation — if a test fails because of a real bug in the repository code as written above, fix the repository code, not the test).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/skills.ts packages/db/src/repositories/skill-versions.ts packages/db/src/repositories/agent-skills.ts packages/db/src/__tests__/repositories/skills.test.ts packages/db/src/__tests__/repositories/agent-skills.test.ts packages/db/src/index.ts
git commit -m "feat(db): add skills/skill-versions/agent-skills repositories

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

**After Task 2 is committed and merged, Tasks 3, 4, and 5 touch disjoint files and can be run in parallel** (each only depends on Task 2's repository exports, not on each other).

---

### Task 3: Skills authoring API + UI

**Files:**
- Create: `apps/web/src/app/api/skills/route.ts` (replace the mock `GET`)
- Create: `apps/web/src/app/api/skills/[skillId]/route.ts`
- Create: `apps/web/src/app/api/skills/[skillId]/draft/route.ts`
- Create: `apps/web/src/app/api/skills/[skillId]/versions/route.ts`
- Create: `apps/web/src/app/api/skills/[skillId]/draft/publish/route.ts`
- Create: `apps/web/src/app/api/skills/[skillId]/assignments/route.ts`
- Create: `apps/web/src/app/(app)/skills/page.tsx`
- Create: `apps/web/src/app/(app)/skills/new/page.tsx`
- Create: `apps/web/src/app/(app)/skills/[skillId]/page.tsx`
- Modify: nav component (find where `(app)/layout.tsx` renders the sidebar — grep for an existing nav item like "Agents" or "Teams" to find the exact component/file) — add a "Skills" entry linking to `/skills`.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` — add a `skills.*` key group (list page empty state, form labels, publish button, version history labels).
- Modify: `apps/web/src/server/mock-store.ts`, `apps/web/src/lib/mock/seed.ts`, `apps/web/src/lib/mock/context.tsx` — remove the `Skill`/`skills` mock plumbing now that `/api/skills` is real (find every `skills`/`Skill` reference in these three files, per the earlier grep in the design spec's Ground Truth section, and delete it — `MockState.skills`, `EMPTY_STATE.skills`, the `apiFetch<Skill[]>("/api/skills")` call and its slot in the `Promise.all` destructure).

**Interfaces:**
- Consumes: `listSkillsForOrg`, `getSkillForOrg`, `createSkillWithDraft`, `deleteSkillForOrg`, `createDraftFromPublished`, `publishDraft` (from `skills.ts`); `getSkillVersionsForSkill`, `getDraftForSkill`, `getSkillVersionMarkdown`, `decomposeSkillMarkdown`, `updateDraft` (from `skill-versions.ts`); `listSkillAssignments` (from `agent-skills.ts`) — all from Task 2.
- Produces (used by Task 4's agent-skill picker UI): the `/skills` list page and `GET /api/skills` response shape `Skill[]` (unchanged shape from today's mock, so Task 4's picker can assume it).

- [ ] **Step 1: `GET/POST /api/skills`**

Follow the auth pattern already used in `apps/web/src/app/api/teams/route.ts` or `apps/web/src/app/api/agents/route.ts` (grep for `requireAuthContext` or equivalent session helper and copy its exact import/usage) for both handlers.

```ts
// GET: list org's skills. POST: { name, description, instructions } -> create skill + draft.
export async function GET(request: Request) {
  const auth = await requireAuthContext(request); // mirror the exact helper used in api/agents/route.ts
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skills = await listSkillsForOrg(auth.orgId);
  return NextResponse.json(skills);
}

export async function POST(request: Request) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  if (!body.name?.trim() || !body.instructions?.trim()) {
    return NextResponse.json({ error: "name and instructions are required" }, { status: 400 });
  }
  const { skill, draft } = await createSkillWithDraft(auth.orgId, {
    name: body.name,
    description: body.description ?? "",
    instructions: body.instructions,
    createdBy: auth.userId,
  });
  return NextResponse.json({ skill, draft }, { status: 201 });
}
```

- [ ] **Step 2: `GET/DELETE /api/skills/[skillId]`**

```ts
export async function GET(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const skill = await getSkillForOrg(skillId, auth.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const versions = await getSkillVersionsForSkill(skillId);
  return NextResponse.json({ skill, versions });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const deleted = await deleteSkillForOrg(skillId, auth.orgId);
  if (!deleted) return NextResponse.json({ error: "Skill is assigned to an agent; unassign it first" }, { status: 409 });
  return new NextResponse(null, { status: 204 });
}
```

(Match the exact `params: Promise<{...}>` async-params convention by checking `apps/web/src/app/api/agents/[agentId]/route.ts` — Next.js 16's route handler signature for dynamic segments; copy it exactly rather than guessing.)

- [ ] **Step 3: `PATCH /api/skills/[skillId]/draft`, `POST /api/skills/[skillId]/versions`, `POST /api/skills/[skillId]/draft/publish`**

```ts
// PATCH /api/skills/[skillId]/draft
export async function PATCH(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const skill = await getSkillForOrg(skillId, auth.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const draft = await getDraftForSkill(skillId);
  if (!draft) return NextResponse.json({ error: "No draft — create one first" }, { status: 404 });
  const body = await request.json();
  const updated = await updateDraft(draft.id, auth.orgId, {
    name: body.name, description: body.description, instructions: body.instructions,
  });
  return NextResponse.json(updated);
}

// POST /api/skills/[skillId]/versions — start a new draft from the currently published version
export async function POST(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const draft = await createDraftFromPublished(skillId, auth.orgId, auth.userId);
  if (!draft) return NextResponse.json({ error: "A draft already exists, or there is nothing published yet" }, { status: 409 });
  return NextResponse.json(draft, { status: 201 });
}

// POST /api/skills/[skillId]/draft/publish
export async function POST(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const draft = await getDraftForSkill(skillId);
  if (!draft) return NextResponse.json({ error: "No draft to publish" }, { status: 404 });
  const result = await publishDraft(skillId, auth.orgId, draft.id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(result);
}
```

- [ ] **Step 3b: `GET /api/skills/[skillId]/assignments`**

```ts
export async function GET(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const skill = await getSkillForOrg(skillId, auth.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await listSkillAssignments(skillId));
}
```

- [ ] **Step 4: Build the `/skills` list page**

Mirror `apps/web/src/app/(app)/teams-v2/page.tsx`'s structure exactly (fetch list via `useMockBackend()` or a direct `apiFetch` call — check which pattern that file uses and copy it): a `PageHeader` with a "New skill" button linking to `/skills/new`, a `Card`/`CardLink` grid (one card per skill: name, description, "vN" badge using `Badge`), and `EmptyState` when the list is empty. Use `useTranslation()` for every visible string, adding the needed keys to `en.ts` first (`skills.title`, `skills.newButton`, `skills.emptyState.title`, `skills.emptyState.body`).

- [ ] **Step 5: Build `/skills/new`**

A form with `TextInput` (Name), `Textarea` (Description), `Textarea` (Instructions), and a `Button` (primary) that `POST`s to `/api/skills` and redirects (`router.push`) to `/skills/${skill.id}` on success. Follow the exact form-state/submit pattern used in `apps/web/src/app/(app)/tasks/new/page.tsx` (controlled inputs, a `submitting` boolean disabling the button, inline error text on failure).

- [ ] **Step 6: Build `/skills/[skillId]`**

Fetch `{ skill, versions }` from `GET /api/skills/${skillId}` on mount. Render:
- The current published version's name/description/instructions (fetch its markdown via a small helper route or just show name+description — the raw body isn't needed read-only here since it's shown in the editor when editing).
- A version history list (`version`, `publishedAt` formatted, "current" `Badge` on the one matching `skill.currentVersionId`).
- An "Edit" button: if `versions` contains an unpublished one (`publishedAt` undefined), navigate to an inline edit form pre-filled from it; otherwise `POST /api/skills/${skillId}/versions` first, then show the edit form. The edit form's fields `PATCH /api/skills/${skillId}/draft` on save (debounce or explicit "Save draft" button — explicit button is simpler and consistent with this codebase's preference for explicit actions per the design spec).
- A "Publish" button (only shown/enabled when a draft exists) that calls `POST /api/skills/${skillId}/draft/publish` and refetches.
- An "Assigned agents" section: fetch `GET /api/skills/${skillId}/assignments` (add this one extra route in this task, backed by Task 2's `listSkillAssignments(skillId)`) and render each row as agent name (linking to `/agents/${agentId}`) + a `Badge` showing `v${version}`. Read-only here — no unassign/upgrade controls on this page; those live on the agent detail page (Task 4), so the two pages never race to mutate the same pin.

- [ ] **Step 7: Wire up the nav entry**

Add the "Skills" nav item using the exact same component/props as the existing "Agents" or "Teams" item in the sidebar (find it by grepping the layout file for the nav item list).

- [ ] **Step 8: Remove the skills mock**

Delete every `Skill`/`skills` reference from `mock-store.ts`, `lib/mock/seed.ts`, and `lib/mock/context.tsx` (the `MockState.skills` field, `EMPTY_STATE.skills`, the `apiFetch<Skill[]>("/api/skills")` line and its `Promise.all` slot). If `context.tsx`'s `useMockBackend()` hook exposes `skills` to consumers, check whether the new `/skills` pages need it — if so, keep a thin `skills` field that now comes from the real API response shape (a `Skill[]`, unchanged), only removing the mock *data source*, not necessarily the field name, to avoid churning every consumer. Use judgment based on how `teams`/`agents` were handled when they went real (compare `context.tsx`'s current `teams`/`agents` handling — they're presumably still exposed the same way, just backed by the real API now).

- [ ] **Step 9: Test and verify**

Run: `pnpm typecheck`
Expected: no errors.

Start the dev server (`pnpm dev`), sign in, navigate to `/skills`, create a skill, publish it, confirm the version history shows "v1 · current." This is a UI-only feature at this point (no worker wiring yet, that's Task 5) so a route-level smoke test is the right bar here — don't attempt to test runtime behavior.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/app/api/skills apps/web/src/app/\(app\)/skills apps/web/src/lib/i18n/dictionaries/en.ts apps/web/src/server/mock-store.ts apps/web/src/lib/mock/seed.ts apps/web/src/lib/mock/context.tsx
git commit -m "feat(web): add Skills authoring UI and API

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Agent-skill assignment API + UI

**Files:**
- Create: `apps/web/src/app/api/agents/[agentId]/skills/route.ts`
- Create: `apps/web/src/app/api/agents/[agentId]/skills/[skillId]/route.ts`
- Modify: `apps/web/src/app/(app)/agents/[agentId]/page.tsx` — add a "Skills" section.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` — add `agentDetail.skills.*` keys.

**Interfaces:**
- Consumes: `listAgentSkills`, `assignSkillToAgent`, `updateAgentSkillVersion`, `unassignSkillFromAgent` (from Task 2's `agent-skills.ts`); `listSkillsForOrg` (Task 2's `skills.ts`) for the "add skill" picker; `getSkillVersionsForSkill` (Task 2's `skill-versions.ts`) for the upgrade dropdown; `GET /api/skills` (Task 3) as the client-side data source for that picker.
- Produces: none consumed by other tasks in this plan.

- [ ] **Step 1: Assignment routes**

```ts
// apps/web/src/app/api/agents/[agentId]/skills/route.ts
export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const agentId = Number((await params).agentId);
  return NextResponse.json(await listAgentSkills(agentId));
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const agentId = Number((await params).agentId);
  const { skillId } = await request.json();
  const pin = await assignSkillToAgent(agentId, Number(skillId));
  if (!pin) return NextResponse.json({ error: "Skill has no published version" }, { status: 400 });
  return NextResponse.json(pin, { status: 201 });
}
```

```ts
// apps/web/src/app/api/agents/[agentId]/skills/[skillId]/route.ts
export async function PATCH(request: Request, { params }: { params: Promise<{ agentId: string; skillId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId, skillId } = await params;
  const { skillVersionId } = await request.json();
  const updated = await updateAgentSkillVersion(Number(agentId), Number(skillId), Number(skillVersionId));
  if (!updated) return NextResponse.json({ error: "Not a published version of this skill" }, { status: 400 });
  return NextResponse.json(updated);
}

export async function DELETE(request: Request, { params }: { params: Promise<{ agentId: string; skillId: string }> }) {
  const auth = await requireAuthContext(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId, skillId } = await params;
  const removed = await unassignSkillFromAgent(Number(agentId), Number(skillId));
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
```

(As in Task 3, confirm the exact auth-helper import and the async-`params` shape against an existing agent sub-route before writing these — do not guess the helper name.)

- [ ] **Step 2: Agent detail page Skills section**

In `apps/web/src/app/(app)/agents/[agentId]/page.tsx`, add a "Skills" card/section fetching `GET /api/agents/${agentId}/skills` on mount, rendering each row as: skill name (linking to `/skills/${skillId}`), a `Badge` showing `v${version}`, a version-select dropdown populated from `GET /api/skills/${skillId}` (its `versions` array, filtered to `publishedAt` truthy) calling `PATCH .../skills/${skillId}` on change, and a remove button calling `DELETE`. Below the list, an "Add skill" control: a select populated from `GET /api/skills` filtered to skills not already in the assigned list, calling `POST /api/agents/${agentId}/skills` on selection.

- [ ] **Step 3: Test and verify**

Run: `pnpm typecheck`
Expected: no errors.

Manual check via `pnpm dev`: assign a skill to an agent, confirm it appears; publish a second version of that skill from `/skills/:id` (Task 3's UI), return to the agent page, use the upgrade dropdown, confirm the pinned version changes; unassign, confirm it disappears.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/agents apps/web/src/app/\(app\)/agents/\[agentId\]/page.tsx apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): add agent-skill assignment UI and API

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Runtime wiring — materialize pinned skills into the sandbox

**Files:**
- Create: `apps/worker/src/skill-paths.ts`
- Create: `apps/worker/src/skills-materialize.ts`
- Test: `apps/worker/src/__tests__/skills-materialize.test.ts`
- Modify: `apps/worker/src/scm-provider.ts` — generalize the single hardcoded exclude pattern to a list.
- Modify: `apps/worker/src/agent-runtime.ts` — accept and pass through skill names.
- Modify: `apps/worker/sandbox-image/run-turn.ts` — read `SKILL_NAMES` env var, pass `skills` to `query()`.
- Modify: `apps/worker/src/worker.ts` — call `materialiseSkills` alongside `materialiseTaskDocuments`, pass the result to `runAgentTurn`.
- Modify: `apps/worker/src/prompt-composition.ts` — correct the stale "no skills index yet" comment (no functional change).

**Interfaces:**
- Consumes: `listAgentSkills` (Task 2's `agent-skills.ts`), `getSkillVersion`/`getSkillVersionMarkdown` (Task 2's `skill-versions.ts`), `createBlobStore` (`@agentfactory/storage`), `SandboxProvider` (`apps/worker/src/sandbox/types.ts`).
- Produces: `materialiseSkills(sandboxProvider, sandboxId, agentId): Promise<string[]>` (the slugs actually written) — called from `worker.ts`; `runAgentTurn(params: { ...existing fields..., skillNames?: string[] })`.

- [ ] **Step 1: `skill-paths.ts`**

```ts
// Mirrors task-document-paths.ts: a leaf module with no imports, so both skills-materialize.ts
// (which writes the files) and scm-provider.ts (which teaches git to ignore them) can share
// these two strings without pulling storage/db into scm-provider's import graph.

// The Claude Agent SDK's own project-level skill discovery path, relative to /workspace (cwd) —
// not a free choice of directory name the way TASK_DOCUMENT_DIR is.
export const SKILL_DIR = ".claude/skills";

export const SKILL_EXCLUDE_PATTERN = "/.claude/skills/";
```

- [ ] **Step 2: `skills-materialize.ts`**

Mirror `task-documents.ts`'s structure exactly (dependency-injection interface, degrade-to-empty-on-error contract):

```ts
import { listAgentSkills } from "@agentfactory/db";
import { getSkillVersion, getSkillVersionMarkdown } from "@agentfactory/db";
import { createBlobStore, type BlobStore } from "@agentfactory/storage";
import type { SandboxProvider } from "./sandbox/types";
import { SKILL_DIR } from "./skill-paths";

export { SKILL_DIR, SKILL_EXCLUDE_PATTERN } from "./skill-paths";

export interface SkillMaterializeDeps {
  listAgentSkills: (agentId: number) => Promise<Array<{ skillId: number; skillVersionId: number; skillSlug: string }>>;
  getSkillVersion: (id: number) => ReturnType<typeof getSkillVersion>;
  getSkillVersionMarkdown: (orgId: number, version: NonNullable<Awaited<ReturnType<typeof getSkillVersion>>>) => Promise<string | undefined>;
  blobStore: BlobStore;
}

function resolveDeps(overrides?: Partial<SkillMaterializeDeps>): SkillMaterializeDeps {
  return {
    listAgentSkills,
    getSkillVersion,
    getSkillVersionMarkdown,
    blobStore: overrides?.blobStore ?? createBlobStore(),
    ...overrides,
  };
}

// Writes each of the agent's pinned skill versions into the sandbox at
// .claude/skills/<slug>/SKILL.md, so the Claude Agent SDK discovers and can load them. Never
// fails the run — same degrade-to-empty contract as materialiseTaskDocuments: a skill that can't
// be materialized is dropped from the enabled list and logged, not a run-ending error.
export async function materialiseSkills(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  agentId: number,
  orgId: number,
  deps?: Partial<SkillMaterializeDeps>,
): Promise<string[]> {
  try {
    const resolved = resolveDeps(deps);
    const pins = await resolved.listAgentSkills(agentId);
    if (pins.length === 0) return [];

    const files: Record<string, string> = {};
    const written: string[] = [];

    for (const pin of pins) {
      const version = await resolved.getSkillVersion(pin.skillVersionId);
      if (!version) {
        console.error(`Agent ${agentId} skill pin references missing version ${pin.skillVersionId}`);
        continue;
      }
      const markdown = await resolved.getSkillVersionMarkdown(orgId, version);
      if (!markdown) {
        console.error(`Skill version ${version.id} (${pin.skillSlug}) has no blob under ${version.bodySha256}`);
        continue;
      }
      files[`${SKILL_DIR}/${pin.skillSlug}/SKILL.md`] = markdown;
      written.push(pin.skillSlug);
    }

    if (written.length === 0) return [];

    for (const slug of written) {
      await execToCompletion(sandboxProvider, sandboxId, ["mkdir", "-p", `/workspace/${SKILL_DIR}/${slug}`]);
    }
    await sandboxProvider.writeFiles(sandboxId, files);
    return written;
  } catch (err) {
    console.error(`Failed to materialise skills for agent ${agentId}:`, err);
    return [];
  }
}

async function execToCompletion(sandboxProvider: SandboxProvider, sandboxId: string, cmd: string[]): Promise<void> {
  for await (const _chunk of sandboxProvider.exec(sandboxId, cmd)) {
    // drained, not collected — same as task-documents.ts's helper
  }
}
```

Note: `listAgentSkills`'s return type from Task 2 is `AgentSkillSummary[]` with a `skillSlug` field — confirm the field name matches exactly what Task 2 actually shipped (this plan named it `skillSlug` in Task 2's `agent-skills.ts`); if Task 2 landed with a different field name, use that name here instead of silently duplicating a mismatched type.

- [ ] **Step 3: Generalize `scm-provider.ts`'s exclude logic**

Find the block in `cloneIntoSandbox` (around line 231-232) that does:

```ts
grep -qxF '${TASK_DOCUMENT_EXCLUDE_PATTERN}' /workspace/.git/info/exclude 2>/dev/null && return 0
printf '%s\\n' '${TASK_DOCUMENT_EXCLUDE_PATTERN}' >> /workspace/.git/info/exclude
```

Replace the single-pattern check with a loop over both patterns (import `SKILL_EXCLUDE_PATTERN` from the new `skill-paths.ts` alongside the existing `TASK_DOCUMENT_EXCLUDE_PATTERN` import). Read the surrounding shell-script-building code first (it's a template string executed via `sandboxProvider.exec`, per the file's existing structure) and adapt the exact syntax rather than guessing — the intent is: for each of `[TASK_DOCUMENT_EXCLUDE_PATTERN, SKILL_EXCLUDE_PATTERN]`, append it to `.git/info/exclude` only if not already present, matching the existing idempotency guarantee for the one pattern that's there today.

- [ ] **Step 4: `agent-runtime.ts` — thread skill names through**

In `runAgentTurn`'s params, add `skillNames?: string[]`. In the `env` object construction (around line 55-63), add:

```ts
if (params.skillNames && params.skillNames.length > 0) {
  env.SKILL_NAMES = params.skillNames.join(",");
}
```

- [ ] **Step 5: `run-turn.ts` — pass `skills` to `query()`**

Add near the top of `main()`, alongside the other `process.env` reads:

```ts
const skillNamesEnv = process.env.SKILL_NAMES;
const skills = skillNamesEnv ? skillNamesEnv.split(",").filter(Boolean) : [];
```

In the `query({ ..., options: { ... } })` call, add `skills,` to the options object — always pass it (an empty array when the agent has no pinned skills), per the design spec's decision to positively disable discovery of any repo-committed skills for a run whose agent has none, rather than omitting the option.

- [ ] **Step 6: `worker.ts` — call site**

Find where `materialiseTaskDocuments` is called (around line 155) and `runAgentTurn` is called (around line 290). Add, right after the `materialiseTaskDocuments` call:

```ts
const skillNames = await materialiseSkills(sandboxProvider, sandboxId, agent.id, agent.orgId);
```

Import `materialiseSkills` from `./skills-materialize`. Pass `skillNames` into the `runAgentTurn({...})` call's params object.

- [ ] **Step 7: Fix the stale comment in `prompt-composition.ts`**

Update the comment at the top of the "Order per ARCHITECTURE.md §3..." block (around line 160-161) that says *"narrowed to this repo's actual scope: no skills index yet"* — remove that clause; skills now exist and are handled by the SDK's own native mechanism (materialized into the sandbox and passed via `query()`'s `skills` option — see `skills-materialize.ts`), not via a prompt segment, so this function's segment list is unchanged by design, not by omission. No code in this file changes.

- [ ] **Step 8: Write the unit test**

`apps/worker/src/__tests__/skills-materialize.test.ts` — follow the fake-`SandboxProvider`/fake-`BlobStore` pattern used in the existing `task-documents.test.ts` (check that file for the exact fake shapes and copy the pattern):

```ts
import { describe, expect, it, vi } from "vitest";
import { materialiseSkills, SKILL_DIR } from "../skills-materialize";

function fakeSandboxProvider() {
  const writes: Record<string, string> = {};
  const commands: string[][] = [];
  return {
    exec: vi.fn(async function* (_id: string, cmd: string[]) {
      commands.push(cmd);
    }),
    writeFiles: vi.fn(async (_id: string, files: Record<string, string>) => {
      Object.assign(writes, files);
    }),
    _writes: writes,
    _commands: commands,
  };
}

function fakeBlobStore(bytesBySha: Record<string, string>) {
  return {
    put: vi.fn(),
    get: vi.fn(async (_orgId: number, sha256: string) =>
      bytesBySha[sha256] ? new TextEncoder().encode(bytesBySha[sha256]) : undefined,
    ),
  };
}

describe("materialiseSkills", () => {
  it("writes each pinned skill's SKILL.md and returns its slug", async () => {
    const sandboxProvider = fakeSandboxProvider();
    const blobStore = fakeBlobStore({ shaA: "---\nname: foo\ndescription: d\n---\n\nBody" });
    const written = await materialiseSkills(sandboxProvider as any, "sandbox-1", 42, 1, {
      listAgentSkills: async () => [{ skillId: 1, skillVersionId: 10, skillSlug: "foo" }],
      getSkillVersion: async () => ({ id: 10, skillId: 1, version: 1, name: "foo", description: "d", bodySha256: "shaA", createdAt: "" }),
      getSkillVersionMarkdown: async () => "---\nname: foo\ndescription: d\n---\n\nBody",
      blobStore: blobStore as any,
    });
    expect(written).toEqual(["foo"]);
    expect(sandboxProvider._writes[`${SKILL_DIR}/foo/SKILL.md`]).toContain("Body");
  });

  it("returns [] when the agent has no pinned skills", async () => {
    const sandboxProvider = fakeSandboxProvider();
    const written = await materialiseSkills(sandboxProvider as any, "sandbox-1", 42, 1, {
      listAgentSkills: async () => [],
    });
    expect(written).toEqual([]);
    expect(sandboxProvider.writeFiles).not.toHaveBeenCalled();
  });

  it("skips a pin whose blob is missing, without failing", async () => {
    const sandboxProvider = fakeSandboxProvider();
    const written = await materialiseSkills(sandboxProvider as any, "sandbox-1", 42, 1, {
      listAgentSkills: async () => [{ skillId: 1, skillVersionId: 10, skillSlug: "foo" }],
      getSkillVersion: async () => ({ id: 10, skillId: 1, version: 1, name: "foo", description: "d", bodySha256: "missing", createdAt: "" }),
      getSkillVersionMarkdown: async () => undefined,
    });
    expect(written).toEqual([]);
  });

  it("returns [] and logs rather than throwing when listAgentSkills rejects", async () => {
    const sandboxProvider = fakeSandboxProvider();
    const written = await materialiseSkills(sandboxProvider as any, "sandbox-1", 42, 1, {
      listAgentSkills: async () => { throw new Error("db down"); },
    });
    expect(written).toEqual([]);
  });
});
```

- [ ] **Step 9: Run the tests**

Run: `pnpm --filter @agentfactory/worker test`
Expected: all four `skills-materialize.test.ts` cases pass. If `scm-provider.ts` has an existing exclude-pattern test, confirm it still passes after Step 3's generalization, and add one asserting `SKILL_EXCLUDE_PATTERN` is also appended.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/skill-paths.ts apps/worker/src/skills-materialize.ts apps/worker/src/__tests__/skills-materialize.test.ts apps/worker/src/scm-provider.ts apps/worker/src/agent-runtime.ts apps/worker/sandbox-image/run-turn.ts apps/worker/src/worker.ts apps/worker/src/prompt-composition.ts
git commit -m "feat(worker): materialize pinned skills into the sandbox and load them via the Claude Agent SDK

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Post-plan manual verification

Once Tasks 3, 4, and 5 have all landed: create a skill whose instructions are distinctive enough to detect in a transcript (e.g. "Always end your final response with the exact phrase SKILL-CHECK-OK"), publish it, pin it to a test agent, start a session with that agent, and confirm the run's final message contains the phrase — this is the first real end-to-end proof the SDK actually loaded and used the skill, which none of the unit/integration tests above can verify on their own (they stop at "the file was written to the right path").
