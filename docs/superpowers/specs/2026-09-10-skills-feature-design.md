# Skills feature — design spec

**Date:** 2026-09-10
**Status:** approved
**Issue:** or-borco/AgentFactory#170

## Problem

`Skill` and `SkillVersion` are modeled in `packages/core/src/domain.ts:164-181` — versioned, with `agent_skills` meant to pin a `skillVersionId` per ARCHITECTURE.md §2.5 — but nothing behind that model is real:

- `GET /api/skills` (`apps/web/src/app/api/skills/route.ts`) reads a hardcoded two-item array (`apps/web/src/lib/mock/seed.ts:9-30`) out of the in-memory `mock-store.ts`. No create, edit, version, or delete route exists.
- `agents.skill_ids` is a plain `jsonb` int array (`packages/db/src/schema.ts:123-126`), explicitly commented as a placeholder: *"not join tables ... those pin skill versions ... which don't exist yet since Skills ... have no real backend of their own."* The real DB seed already sets `skillIds: [1]` on one agent (`packages/db/src/seed.ts:166`) pointing at nothing real.
- The worker never loads a skill into a run. `apps/worker/sandbox-image/run-turn.ts` calls the Claude Agent SDK's `query()` with no `skills` option at all, and `prompt-composition.ts:160-161` says so directly: *"no skills index yet."*

So today an agent can be assigned a skill in the UI and it has zero effect on any run.

## Goal

A centralized Skills library where a human authors and versions a Skill as a single Markdown-with-frontmatter document (the Claude Agent SDK's native `SKILL.md` shape), assigns a specific published version to an Agent, and has that version actually loaded by the Claude Agent SDK during the agent's runs — without any provider-specific format leaking into `packages/core` or the DB layer beyond the version pin itself.

## Ground truth this design relies on

- **The Claude Agent SDK has native skill support**, confirmed by reading its shipped types (`@anthropic-ai/claude-agent-sdk@0.3.220`, `sdk.d.ts`): it discovers `SKILL.md` files under a project's `.claude/skills/<name>/` (relative to `cwd`) and a `skills?: string[] | 'all'` query option "enable[s] only the listed skills... names match the SKILL.md `name` / directory name," with its own progressive-disclosure listing built in (`sdk.d.ts:1911-1933`). This means the platform does **not** need to build its own "skills index" prompt segment or a `load_skill` tool fallback (ARCHITECTURE.md §1's fallback path is for a runtime *without* this capability) — we use the SDK's real mechanism directly.
- **The sandbox runs the SDK's `query()` directly**, not through an intermediate abstraction: `apps/worker/sandbox-image/run-turn.ts:26-41` passes `model`, `systemPrompt`, `cwd: "/workspace"`, `permissionMode: "bypassPermissions"`, `resume` as env-var-driven options. Adding `skills` here is a one-line addition to that same options object, driven by a new env var, mirroring how `RESUME_SESSION_REF` already works.
- **`apps/worker/src/agent-runtime.ts:55-63`** (`runAgentTurn`) is the one place that builds the env object handed to the sandboxed process — a new `SKILL_NAMES` (or similar) env var is added here, not in `worker.ts` or `run-turn.ts` independently.
- **There is an exact precedent for writing platform-owned files into a session's git checkout without them ever being committed**: `apps/worker/src/task-documents.ts` (`materialiseTaskDocuments`) writes indexed task documents into `/workspace/.agentfactory/context/` via `sandboxProvider.writeFiles`, and `apps/worker/src/task-document-paths.ts` defines both the directory and the exact string appended to `.git/info/exclude`. `apps/worker/src/scm-provider.ts:213-232` (`cloneIntoSandbox`) does the appending — today hardcoded to check for and append exactly one pattern, `TASK_DOCUMENT_EXCLUDE_PATTERN`.
- **Content-addressed blob storage already exists and is reused, not reinvented**: `packages/storage` (`BlobStore` port, `FsBlobStore`/`S3BlobStore` adapters, `createBlobStore()`) and `content_blobs` (`packages/db/src/schema.ts:351-372`, keyed `(org_id, sha256)`) are exactly what ARCHITECTURE.md §2.5 asks a skill's body to live in. `team_context_items` (`packages/db/src/repositories/team-context-items.ts`) is the closest existing repository shape to model `skills`/`skill_versions` on.
- **`packages/db/src/repositories/agents.ts:26,72`** currently reads/defaults `skillIds` straight off the `agents` row — this goes away with the join table.
- No agent-edit form exists yet beyond `apps/web/src/app/(app)/agents/[agentId]/page.tsx` (a detail view); ARCHITECTURE.md §7 lists a full edit form, including a skills picker, as still-needed "beyond the mocks." This design adds the skills section to whatever agent surface exists today rather than building the full edit form (out of scope, pre-existing gap).

## Scope

- `packages/db/src/schema.ts` — new `skills`, `skill_versions`, `agent_skills` tables; drop `agents.skill_ids`.
- `packages/db/drizzle/` — generated migration.
- `packages/core/src/domain.ts` — `Skill`, `SkillVersion` gain the fields below; new `AgentSkill` type; `Agent.skillIds` removed.
- `packages/db/src/repositories/skills.ts`, `skill-versions.ts`, `agent-skills.ts` (new) — CRUD + publish + pin, modeled on `team-context-items.ts`.
- `packages/db/src/repositories/agents.ts` — drop `skillIds` read/write.
- `packages/db/src/seed.ts` — replace the dangling `skillIds: [1]` with a real seeded skill + version + `agent_skills` row.
- `apps/web/src/app/api/skills/**`, `apps/web/src/app/api/skills/[skillId]/**` (new routes, replacing the mock GET).
- `apps/web/src/app/api/agents/[agentId]/skills/**` (new).
- `apps/web/src/app/(app)/skills/page.tsx`, `apps/web/src/app/(app)/skills/[skillId]/page.tsx`, `.../new/page.tsx` (new).
- Agent detail page (`agents/[agentId]/page.tsx`) — new "Skills" section.
- Nav — add "Skills" entry alongside the existing sidebar items.
- `apps/worker/src/task-document-paths.ts`-equivalent: new `skill-paths.ts` (directory + exclude pattern).
- `apps/worker/src/scm-provider.ts` — generalize the single hardcoded exclude-pattern check to a list.
- `apps/worker/src/skills-materialize.ts` (new) — mirrors `task-documents.ts`.
- `apps/worker/src/agent-runtime.ts`, `apps/worker/sandbox-image/run-turn.ts` — pass enabled skill names through to `query()`.
- `apps/worker/src/worker.ts` — call the new materialize step before the turn, alongside `materialiseTaskDocuments`.
- `apps/worker/src/prompt-composition.ts` — update the now-stale "no skills index yet" comment (no functional change to `composeSystemPrompt`).
- `apps/web/src/lib/i18n/dictionaries/en.ts` — new strings for the Skills UI.
- `apps/web/src/lib/mock/context.tsx`, `mock-store.ts`, `lib/mock/seed.ts` — drop the skills mock path now that `/api/skills` is real (matches how teams/agents already left this file behind).

## Out of scope

- **`git`-sourced skills** (`SkillSource: "git"` stays in the type for forward-compatibility per ARCHITECTURE.md §2.5, but this design only ever writes `"authored"`; no import-from-repo flow).
- **Multi-file bundles** (scripts, reference files alongside `SKILL.md`). A skill version is exactly one Markdown file. ARCHITECTURE §2.5's "bundle" language is aspirational; revisit if a real skill needs attached scripts.
- **The general Agent edit form.** This design adds a Skills section wherever agent editing already happens; it does not build the form ARCHITECTURE §7 flags as a pre-existing gap.
- **Per-tool or per-skill fine-grained runtime scoping** beyond the existing `ToolPolicy`.
- **Skill deletion cascading rules beyond a simple guard** (a skill assigned to at least one agent cannot be deleted; unassign first).

## Design decisions

- **One SKILL.md per version, composed from structured inputs, not hand-edited YAML.** The editor exposes **Name**, **Description**, and an **Instructions** textarea as separate fields; the frontmatter (`name`, `description`) plus body are assembled into one Markdown string at save time. This keeps the stored/materialized artifact byte-for-byte what the SDK expects natively, while removing YAML-syntax mistakes as a failure mode. `name` is derived from (and kept in sync with) the skill's `slug`, since the SDK matches skill names against `SKILL.md`'s `name` / directory name and slugs are already guaranteed valid identifiers elsewhere in this codebase.
- **Draft is a version row, not a separate table.** `skill_versions.published_at` nullable: a row with `published_at: null` is the mutable draft (at most one per skill, edited in place via `PATCH`); publishing sets `published_at`, freezes the row, and atomically updates `skills.current_version_id` + the denormalized `skills.name/description`. This avoids a parallel `skill_drafts` table for what is structurally "one version that hasn't been published yet," and matches how `runs.status` transitions are handled elsewhere in this codebase (explicit, one-way).
- **`skills.name`/`description`/`slug` denormalize the current *published* version.** Per ARCHITECTURE §2.5, these must be readable without touching blob storage (skill list page, agent-assignment picker). They are never read from the draft — an in-progress edit must not change what's shown as "currently in effect" until published.
- **`agent_skills` is keyed `(agent_id, skill_id)`, not `(agent_id, skill_version_id)`.** An agent has at most one pinned version *per skill*; "upgrade" is an `UPDATE` of `skill_version_id` on the existing row (explicit, auditable — the existing `audit_log` table gets a row), not an insert-a-new-pin-and-orphan-the-old-one. This is what ARCHITECTURE §2.5's "upgrades are explicit" principle means in practice.
- **No new prompt segment for skills.** Ground truth above: the SDK's own `skills` option and its native listing already do progressive disclosure. `composeSystemPrompt` (`prompt-composition.ts`) is unchanged; only its stale comment is corrected.
- **Skill materialization follows the task-documents pattern exactly**: a dedicated directory (`.claude/skills/<slug>/SKILL.md`, chosen because it's the SDK's own discovery path — unlike task documents this is *not* a free choice of directory name), written via `sandboxProvider.writeFiles` before the turn, added to `.git/info/exclude` so it's never accidentally committed or pushed. Because `.claude/skills/` is also where a *cloned repository's own* project-level skills could legitimately live, a name collision between a platform-authored skill and a repo-committed skill of the same slug means the platform's copy locally shadows the repo's for that run (session-scoped, never pushed) — an accepted limitation, not solved here.
- **`scm-provider.ts`'s exclude-pattern check becomes a list, not a second hardcoded branch.** `cloneIntoSandbox` currently greps for one exact pattern (`TASK_DOCUMENT_EXCLUDE_PATTERN`) before appending it; this becomes a small loop over `[TASK_DOCUMENT_EXCLUDE_PATTERN, SKILL_EXCLUDE_PATTERN]` so a third future exclude doesn't need a third copy-pasted branch.
- **Skill names reach the sandbox as an env var, `SKILL_NAMES`** (comma-separated slugs), exactly parallel to `RESUME_SESSION_REF` — `runAgentTurn` (`agent-runtime.ts`) sets it when the agent has any pinned skills; `run-turn.ts` reads it and passes `skills: names` (omitting the option entirely, not `skills: []`, when there are none — per the SDK's own doc, an *omitted* option is "not skills off," so an explicit empty array is used only when the agent has zero pinned skills, to positively disable discovery of any repo-committed skills for that run rather than falling back to whatever the SDK's default would otherwise be).
- **The skills mock (`mock-store.ts`, `lib/mock/seed.ts`, `MockState.skills`) is deleted, not kept alongside the real API**, matching how teams/agents/tasks already dropped their mock paths as they went real (per CLAUDE.md's mock-phase description, which this feature completes for skills).

## Mechanism

### Schema

```ts
export const skills = pgTable(
  "skills",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    source: text("source").notNull().default("authored"), // "authored" | "git" (git unused for now)
    currentVersionId: integer("current_version_id"), // set on first publish
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
    skillId: integer("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(), // 1, 2, 3... per skill, assigned at publish time
    name: text("name").notNull(),
    description: text("description").notNull(),
    bodySha256: text("body_sha256").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }), // null = draft
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.bodySha256], foreignColumns: [contentBlobs.orgId, contentBlobs.sha256] }),
    uniqueIndex("skill_versions_draft_per_skill").on(t.skillId).where(sql`published_at IS NULL`),
  ],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: integer("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    skillId: integer("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: integer("skill_version_id").notNull().references(() => skillVersions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);
```

`current_version_id` has no FK declared against `skill_versions` in the table body (matches the existing codebase's tolerance for one soft forward-reference — same shape as `content_blobs`/`context_items`); it is always written in the same transaction as the version it points to.

`packages/core/src/domain.ts`: `SkillVersion` gains `name: string`, `description: string`, `publishedAt?: ISODateTime`. New `AgentSkill { agentId: ID; skillId: ID; skillVersionId: ID; createdAt: ISODateTime }`. `Agent.skillIds: ID[]` is deleted.

### API

- `GET /api/skills` — list org's skills (id, name, slug, description, currentVersionId).
- `POST /api/skills` — `{ name, description, instructions }` → creates `skills` row + one draft `skill_versions` row (`version: 1`, unpublished — the version number a draft is assigned at creation, since only one draft can exist per skill at a time, is exactly the number it will carry if published, so publish never recomputes it).
- `GET /api/skills/:id` — skill + all versions (published + the one draft, if any).
- `PATCH /api/skills/:id/draft` — `{ name?, description?, instructions? }`, 404 if no draft exists (call `POST .../versions` first).
- `POST /api/skills/:id/versions` — create a new draft seeded from the current published version's content, `version: max(published version)+1`; 409 if a draft already exists.
- `POST /api/skills/:id/draft/publish` — freezes the draft (`publishedAt = now()`), updates `skills.current_version_id/name/description/slug-derived-name`, all in one transaction.
- `DELETE /api/skills/:id` — 409 if any `agent_skills` row references it.
- `POST /api/agents/:agentId/skills` — `{ skillId }` → pins the skill's currently published version; 400 if the skill has no published version yet.
- `PATCH /api/agents/:agentId/skills/:skillId` — `{ skillVersionId }` → change the pin (must be a published version of that skill); writes an `audit_log` row.
- `DELETE /api/agents/:agentId/skills/:skillId` — unassign.

### Runtime wiring

```
worker.ts (per run, alongside materialiseTaskDocuments):
  skillNames = await materialiseSkills(sandboxProvider, sandboxId, agent.id, agent.orgId)
  // skillNames: string[] — the slugs actually written, [] if the agent has none or on any error

agent-runtime.ts (runAgentTurn):
  env.SKILL_NAMES = skillNames.join(",")   // set unconditionally (possibly "")

run-turn.ts:
  const skillNames = (process.env.SKILL_NAMES ?? "").split(",").filter(Boolean);
  query({ ..., options: { ..., skills: skillNames } })
```

`materialiseSkills` (new `apps/worker/src/skills-materialize.ts`, same shape as `task-documents.ts`):

```
1. agentSkillRows = await listAgentSkills(agentId, orgId)   // joins agent_skills → skill_versions → skills
2. if empty: return []
3. for each row: bytes = blobStore.get(orgId, row.bodySha256); skip+log if missing
4. mkdir -p /workspace/.claude/skills/<slug> per skill (slug reused as both dir name and frontmatter `name`)
5. writeFiles({ ".claude/skills/<slug>/SKILL.md": bytes })
6. return the slugs actually written
```

Never fails the run — same degrade-to-empty contract as `materialiseTaskDocuments`.

`scm-provider.ts`'s `cloneIntoSandbox` exclude step becomes a loop over `EXCLUDE_PATTERNS = [TASK_DOCUMENT_EXCLUDE_PATTERN, SKILL_EXCLUDE_PATTERN]` (new `skill-paths.ts` exports `SKILL_DIR = ".claude/skills"` and `SKILL_EXCLUDE_PATTERN = "/.claude/skills/"`).

### UI

- **`/skills`** — Card grid (name, description, version count), `EmptyState` when none, "New skill" button → `/skills/new`.
- **`/skills/new`** — Name, Description, Instructions (Textarea) → `POST /api/skills`, redirect to `/skills/:id`.
- **`/skills/:id`** — published version's content (read-only) + version history list (version #, published date, author) + "Edit" (creates/resumes a draft, opens the same form as `/new` pre-filled) + "Publish" (only enabled with unsaved draft changes) + "Assigned agents" list with each agent's pinned version and an "Unassign" action, mirroring the Team detail page's existing "Assigned agents" section.
- **Agent detail page** — new "Skills" section: assigned skills with pinned version + a version-upgrade dropdown (published versions only) + an "Add skill" picker (org's skills not yet assigned) + remove.

## Testing

- **DB integration** (`packages/db/src/__tests__/repositories/`, real Postgres — matches existing suites): `skills`/`skill-versions` lifecycle (create → draft → publish → second draft → second publish), the partial-unique-index guarantee (at most one draft per skill), `agent-skills` pin/upgrade/unassign, delete-guard when a skill is assigned.
- **Unit** (`apps/worker/src/__tests__/`, fake `SandboxProvider`/`BlobStore` — matches `task-documents.test.ts`'s pattern): `materialiseSkills` — writes exactly the pinned versions' bodies to the right paths, skips-and-logs a missing blob without failing, returns `[]` on zero skills or on a thrown error. `scm-provider.ts`'s exclude-loop appends both patterns idempotently (grep-before-append, matching the existing single-pattern test).
- **Route handler tests** (`apps/web/src/server/__tests__/` or equivalent, following whatever pattern the existing task/team routes use): publish freezes the draft (a further `PATCH` 404s), `agent_skills` pin rejects an unpublished version, upgrade writes an `audit_log` row.
- **Manual/E2E**: create a skill, publish it, assign it to an agent, run a session, confirm (via the run's tool-call/thinking events already surfaced in the UI) the agent used the `Skill` tool for it — the closest this repo gets to an actual runtime assertion without a recorded-fixture harness for the Agent SDK itself.

## PR sequence

| # | PR | Contents | Demoable |
|---|---|---|---|
| 1 | **Schema + core types** | `skills`, `skill_versions`, `agent_skills` tables + migration; drop `agents.skill_ids`; `packages/core/domain.ts` changes; seed data fixed | No |
| 2 | **Skills repositories** | `packages/db/src/repositories/skills.ts`, `skill-versions.ts`, `agent-skills.ts` | No |
| 3 | **Skills authoring API + UI** | `/api/skills/**` routes, `/skills`, `/skills/new`, `/skills/:id` pages, nav entry; mock skills path deleted | Yes — author and publish a skill end to end |
| 4 | **Assignment API + UI** | `/api/agents/[agentId]/skills/**`, Agent detail page's Skills section | Yes — pin/upgrade/unassign from the UI |
| 5 | **Runtime wiring** | `skill-paths.ts`, `skills-materialize.ts`, `scm-provider.ts` exclude-loop generalization, `agent-runtime.ts`/`run-turn.ts` `SKILL_NAMES` plumbing, `worker.ts` call site, stale comment fix in `prompt-composition.ts` | Yes — a pinned skill is actually loaded and used in a real run |

PRs 1-2 carry no visible behavior (schema/repo only), kept small for fast review per the size guideline. PR 5 is where the feature becomes real rather than inert configuration — matches the issue's explicit ask.

## Risks

- **`.claude/skills/<slug>` can collide with a same-named skill the target repository itself commits.** Flagged above as an accepted limitation (session-scoped shadowing, never pushed) rather than solved — revisit if it causes real confusion.
- **The SDK's exact skill-matching semantics (name vs. directory vs. `plugin:skill` qualification) are read from shipped `.d.ts` comments, not from running it against a real multi-skill sandbox yet.** The runtime-wiring PR's manual/E2E check above is the first real validation; if slugs don't match as expected, `materialiseSkills`'s directory-naming may need adjustment.
- **No skill content size cap is specified here.** Unlike task documents (`TASK_DOCUMENTS_BUDGET_BYTES`) or team shared context (64 KB), a skill body has no enforced ceiling. Given skill bodies are hand-authored (not uploaded arbitrary files), this is lower risk, but worth adding a cap (e.g. matching `shared_context`'s 64 KB) if real usage shows it's needed.
