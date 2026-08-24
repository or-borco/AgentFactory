# Repo Map Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-generate a CLAUDE.md-style "repo map" per repo, cache it keyed to the exact commit it describes, inject it into every run's system prompt, and pre-warm the cache when a repo is assigned to an agent or team.

**Architecture:** A new `repo_maps` Postgres table (org + repo + commit sha → cached text) backs two entry points into the same core generation logic (`apps/worker/src/repo-map.ts`): a run-time path (`ensureRepoMap`, called from the existing run pipeline right after clone) and a pre-warm path (`warmRepoMap`, run by a new BullMQ queue processor triggered when an agent's or team's `defaultCodebase` is set). Generation itself is a second, independent Claude Agent SDK call inside the sandbox, fixed to a cheap model, with its own script in `apps/worker/sandbox-image/`.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), BullMQ (Redis), Vitest, Claude Agent SDK, Next.js Route Handlers.

## Global Constraints

- Repo map content is capped at **16384 characters** (`repo_maps_content_max_length` CHECK constraint), enforced again by truncation in application code before insert.
- Generation always uses model id **`claude-haiku-4-5`**, regardless of the agent's own assigned model.
- `repo_maps` cache key is `(orgId, repoFullName, commitSha)` — exact HEAD, not a merge-base (see spec's "Design decisions" for the accepted tradeoff).
- Every failure path (generation error, timeout, sandbox error) falls back to an empty map string and never throws out of `ensureRepoMap`/`warmRepoMap` into the caller's run — non-blocking per ARCHITECTURE.md §6.
- A pre-warm job's sandbox is created and destroyed **only** within `warmRepoMap`; destruction is a `finally` block so it runs even when clone or generation fails. The run-time path's sandbox (a session's long-lived warm container) is never destroyed by this feature.
- Reference spec: `docs/superpowers/specs/2026-08-23-repo-map-indexing-design.md`.

---

### Task 1: `repo_maps` table + repository

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/__tests__/setup.ts`
- Create: `packages/db/src/repositories/repo-maps.ts`
- Create: `packages/db/src/__tests__/repositories/repo-maps.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/__tests__/fixtures.ts`

**Interfaces:**
- Produces: `RepoMap { id, orgId, repoFullName, commitSha, content, generationCostUsd, generationTokens, createdAt }`, `getRepoMap(orgId: number, repoFullName: string, commitSha: string): Promise<RepoMap | undefined>`, `insertRepoMap(input: { orgId, repoFullName, commitSha, content, generationCostUsd, generationTokens }): Promise<void>` — all consumed by Task 7's `ensureRepoMap`.

- [ ] **Step 1: Add the `repoMaps` table to the schema**

Add the `uniqueIndex` import and the table itself at the end of `packages/db/src/schema.ts`:

```ts
// packages/db/src/schema.ts — top import block, add uniqueIndex alongside the existing names:
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
```

```ts
// packages/db/src/schema.ts — append after the `events` table at the end of the file.

// Auto-generated CLAUDE.md-style summary of a repo, cached per exact commit so it self-
// invalidates the moment the code moves on — see docs/superpowers/specs/
// 2026-08-23-repo-map-indexing-design.md. Plain text, not S3/content-addressed, following
// teams.sharedContext's reasoning (small, hot, read on every run) rather than the
// skills-bundle pattern.
export const repoMaps = pgTable(
  "repo_maps",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    commitSha: text("commit_sha").notNull(),
    content: text("content").notNull(),
    generationCostUsd: doublePrecision("generation_cost_usd").notNull().default(0),
    generationTokens: integer("generation_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("repo_maps_org_repo_sha").on(table.orgId, table.repoFullName, table.commitSha),
    check("repo_maps_content_max_length", sql`char_length(${table.content}) <= 16384`),
  ],
);
```

- [ ] **Step 2: Generate and review the migration**

Run:
```bash
pnpm --filter @agentfactory/db db:generate
```
Expected: a new file `packages/db/drizzle/0012_<generated_name>.sql` containing `CREATE TABLE "repo_maps" (...)`, a unique index on `(org_id, repo_full_name, commit_sha)`, and the length CHECK constraint. Review the generated SQL before continuing.

- [ ] **Step 3: Add `repo_maps` to the test-DB truncation list**

In `packages/db/src/__tests__/setup.ts`, add `"repo_maps"` to `TABLES_LEAVES_FIRST` (it only FKs to `orgs`, so any position before `"orgs"` is safe — place it first):

```ts
const TABLES_LEAVES_FIRST = [
  "repo_maps",
  "events",
  "runs",
  "messages",
  "tasks",
  "sessions",
  "connections",
  "agents",
  "teams",
  "auth_sessions",
  "memberships",
  "users",
  "orgs",
] as const;
```

- [ ] **Step 4: Write the failing repository test**

Create `packages/db/src/__tests__/repositories/repo-maps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import "../setup.js";
import { getRepoMap, insertRepoMap } from "../../repositories/repo-maps.js";
import { insertOrg } from "../fixtures.js";

describe("repo-maps repository", () => {
  it("returns undefined when no map is cached for a commit", async () => {
    const org = await insertOrg();
    await expect(getRepoMap(org.id, "acme/widgets", "deadbeef")).resolves.toBeUndefined();
  });

  it("inserts and fetches a map by (org, repo, commit sha)", async () => {
    const org = await insertOrg();
    await insertRepoMap({
      orgId: org.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "# Repo map\n\nUse pnpm.",
      generationCostUsd: 0.002,
      generationTokens: 1500,
    });

    const map = await getRepoMap(org.id, "acme/widgets", "abc123");
    expect(map).toMatchObject({
      orgId: org.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "# Repo map\n\nUse pnpm.",
      generationCostUsd: 0.002,
      generationTokens: 1500,
    });
  });

  it("truncates content to 16384 characters before storing", async () => {
    const org = await insertOrg();
    const oversized = "a".repeat(20_000);

    await insertRepoMap({
      orgId: org.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: oversized,
      generationCostUsd: 0,
      generationTokens: 0,
    });

    const map = await getRepoMap(org.id, "acme/widgets", "abc123");
    expect(map!.content).toHaveLength(16384);
  });

  it("does not fail on a concurrent insert for the same (org, repo, commit sha) — only one row survives", async () => {
    const org = await insertOrg();
    const input = {
      orgId: org.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "first",
      generationCostUsd: 0,
      generationTokens: 0,
    };

    await insertRepoMap(input);
    await insertRepoMap({ ...input, content: "second" }); // loses the race, no-ops

    const map = await getRepoMap(org.id, "acme/widgets", "abc123");
    expect(map!.content).toBe("first");
  });

  it("scopes lookups by orgId — a map for one org is invisible to another", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    await insertRepoMap({
      orgId: org1.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "org1 map",
      generationCostUsd: 0,
      generationTokens: 0,
    });

    await expect(getRepoMap(org2.id, "acme/widgets", "abc123")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm vitest run packages/db/src/__tests__/repositories/repo-maps.test.ts --project db-integration`
Expected: FAIL — `Cannot find module '../../repositories/repo-maps.js'`

- [ ] **Step 6: Implement the repository**

Create `packages/db/src/repositories/repo-maps.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { repoMaps } from "../schema";

const CONTENT_MAX_CHARS = 16384;

// Worker-internal shape, not part of @agentfactory/core — nothing outside apps/worker reads a
// repo map today, same reasoning as SandboxSpec/Sandbox in apps/worker/src/sandbox/types.ts.
export interface RepoMap {
  id: number;
  orgId: number;
  repoFullName: string;
  commitSha: string;
  content: string;
  generationCostUsd: number;
  generationTokens: number;
  createdAt: string;
}

function toRepoMap(row: typeof repoMaps.$inferSelect): RepoMap {
  return {
    id: row.id,
    orgId: row.orgId,
    repoFullName: row.repoFullName,
    commitSha: row.commitSha,
    content: row.content,
    generationCostUsd: row.generationCostUsd,
    generationTokens: row.generationTokens,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getRepoMap(
  orgId: number,
  repoFullName: string,
  commitSha: string,
): Promise<RepoMap | undefined> {
  const [row] = await db
    .select()
    .from(repoMaps)
    .where(
      and(eq(repoMaps.orgId, orgId), eq(repoMaps.repoFullName, repoFullName), eq(repoMaps.commitSha, commitSha)),
    );
  return row ? toRepoMap(row) : undefined;
}

export interface NewRepoMapInput {
  orgId: number;
  repoFullName: string;
  commitSha: string;
  content: string;
  generationCostUsd: number;
  generationTokens: number;
}

// Truncates defensively (belt-and-suspenders alongside the repo_maps_content_max_length CHECK
// constraint) and no-ops on a concurrent insert for the same (org, repo, sha) — two runs can
// race to generate a map for a brand-new commit; only the first insert needs to win.
export async function insertRepoMap(input: NewRepoMapInput): Promise<void> {
  await db
    .insert(repoMaps)
    .values({
      orgId: input.orgId,
      repoFullName: input.repoFullName,
      commitSha: input.commitSha,
      content: input.content.slice(0, CONTENT_MAX_CHARS),
      generationCostUsd: input.generationCostUsd,
      generationTokens: input.generationTokens,
    })
    .onConflictDoNothing();
}
```

Add the export to `packages/db/src/index.ts`:

```ts
export * from "./repositories/repo-maps";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run packages/db/src/__tests__/repositories/repo-maps.test.ts --project db-integration`
Expected: PASS (5 tests)

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/__tests__/setup.ts packages/db/src/repositories/repo-maps.ts packages/db/src/__tests__/repositories/repo-maps.test.ts packages/db/src/index.ts packages/db/drizzle
git commit -m "feat(db): add repo_maps table and repository"
```

---

### Task 2: `teams.defaultCodebase` column

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/repositories/teams.ts`
- Modify: `packages/core/src/domain.ts`
- Modify: `packages/db/src/__tests__/fixtures.ts`
- Modify: `packages/db/src/__tests__/repositories/teams.test.ts`

**Interfaces:**
- Produces: `Team.defaultCodebase?: string`, `createTeam(orgId: number, name: string, description: string, defaultCodebase?: string): Promise<Team>`, `updateTeam(teamId: number, patch: { name?, description?, sharedContext?, defaultCodebase? }): Promise<Team | undefined>` — consumed by Task 12's web routes and UI.

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema.ts`, add to the `teams` table (after `githubTeamSlug`):

```ts
export const teams = pgTable(
  "teams",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    sharedContext: text("shared_context").notNull().default(""),
    githubTeamSlug: text("github_team_slug"),
    // Triggers a non-blocking repo-map pre-warm when set/changed (apps/worker's
    // repo-map-warm queue) — has no effect on which repo an agent or task actually uses.
    defaultCodebase: text("default_codebase"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("teams_name_max_length", sql`char_length(${table.name}) <= 80`),
    check("teams_shared_context_max_bytes", sql`octet_length(${table.sharedContext}) <= 65536`),
  ],
);
```

- [ ] **Step 2: Generate the migration**

Run:
```bash
pnpm --filter @agentfactory/db db:generate
```
Expected: a new file `packages/db/drizzle/0013_<generated_name>.sql` containing `ALTER TABLE "teams" ADD COLUMN "default_codebase" text;`

- [ ] **Step 3: Add `Team.defaultCodebase` to the core domain type**

In `packages/core/src/domain.ts`:

```ts
export interface Team {
  id: ID;
  orgId: ID;
  name: string;
  description?: string;
  sharedContext: string; // capped at 64KB, see ARCHITECTURE.md §2.3
  githubTeamSlug?: string;
  defaultCodebase?: string;
  createdAt: ISODateTime;
}
```

- [ ] **Step 4: Write the failing repository test**

Add to `packages/db/src/__tests__/repositories/teams.test.ts`:

```ts
  it("stores and returns defaultCodebase, and clears it when patched to empty string", async () => {
    const org = await insertOrg();
    const team = await createTeam(org.id, "Platform", "", "acme-corp/backend");
    expect(team.defaultCodebase).toBe("acme-corp/backend");

    const updated = await updateTeam(team.id, { defaultCodebase: "acme-corp/frontend" });
    expect(updated?.defaultCodebase).toBe("acme-corp/frontend");

    const cleared = await updateTeam(team.id, { defaultCodebase: "" });
    expect(cleared?.defaultCodebase).toBeUndefined();
  });
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm vitest run packages/db/src/__tests__/repositories/teams.test.ts --project db-integration`
Expected: FAIL — `createTeam` doesn't accept a 4th argument / `defaultCodebase` doesn't exist on the returned type.

- [ ] **Step 6: Widen the teams repository**

In `packages/db/src/repositories/teams.ts`:

```ts
function toTeam(row: typeof teams.$inferSelect): Team {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    description: row.description ?? undefined,
    sharedContext: row.sharedContext,
    githubTeamSlug: row.githubTeamSlug ?? undefined,
    defaultCodebase: row.defaultCodebase ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createTeam(
  orgId: number,
  name: string,
  description: string,
  defaultCodebase?: string,
): Promise<Team> {
  const [row] = await db
    .insert(teams)
    .values({
      orgId,
      name: capName(name),
      description: description || null,
      sharedContext: "",
      defaultCodebase: defaultCodebase || null,
    })
    .returning();
  return toTeam(row);
}

export async function updateTeam(
  teamId: number,
  patch: { name?: string; description?: string; sharedContext?: string; defaultCodebase?: string },
): Promise<Team | undefined> {
  const values: Partial<typeof teams.$inferInsert> = {};
  if (patch.name !== undefined) values.name = capName(patch.name);
  if (patch.description !== undefined) values.description = patch.description || null;
  if (patch.sharedContext !== undefined) values.sharedContext = capSharedContext(patch.sharedContext);
  if (patch.defaultCodebase !== undefined) values.defaultCodebase = patch.defaultCodebase || null;

  if (Object.keys(values).length === 0) return getTeam(teamId);
  const [row] = await db.update(teams).set(values).where(eq(teams.id, teamId)).returning();
  return row ? toTeam(row) : undefined;
}
```

- [ ] **Step 7: Widen the `insertTeam` fixture**

In `packages/db/src/__tests__/fixtures.ts`:

```ts
export async function insertTeam(
  orgId: number,
  overrides: Partial<{ name: string; description: string; defaultCodebase: string }> = {},
): Promise<Team> {
  return createTeam(orgId, overrides.name ?? "Test Team", overrides.description ?? "", overrides.defaultCodebase);
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm vitest run packages/db/src/__tests__/repositories/teams.test.ts --project db-integration`
Expected: PASS (all teams tests, including the new one)

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/repositories/teams.ts packages/core/src/domain.ts packages/db/src/__tests__/fixtures.ts packages/db/src/__tests__/repositories/teams.test.ts packages/db/drizzle
git commit -m "feat(db): add teams.defaultCodebase"
```

---

### Task 3: `repo-map-warm` queue

**Files:**
- Modify: `packages/queue/src/index.ts`
- Create: `packages/queue/src/__tests__/repo-map-warm-queue.test.ts`

**Interfaces:**
- Produces: `REPO_MAP_WARM_QUEUE_NAME: string`, `RepoMapWarmJobData { orgId: number; repoFullName: string }`, `enqueueRepoMapWarmJob(orgId: number, repoFullName: string): Promise<void>` — consumed by Task 10 (worker processor) and Task 11/12 (web routes).

- [ ] **Step 1: Write the failing test**

Create `packages/queue/src/__tests__/repo-map-warm-queue.test.ts`:

```ts
import "./setup.js";
import { Queue } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { REPO_MAP_WARM_QUEUE_NAME, enqueueRepoMapWarmJob, queueConnection } from "../index.js";

const inspectQueue = new Queue(REPO_MAP_WARM_QUEUE_NAME, { connection: queueConnection });

afterEach(async () => {
  await inspectQueue.obliterate({ force: true });
});

afterAll(async () => {
  await inspectQueue.close();
  await queueConnection.quit();
});

describe("enqueueRepoMapWarmJob", () => {
  it("adds a job carrying the org id and repo name", async () => {
    await enqueueRepoMapWarmJob(1, "acme-corp/backend");

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("warm-repo-map");
    expect(jobs[0].data).toEqual({ orgId: 1, repoFullName: "acme-corp/backend" });
  });

  it("collapses duplicate warm requests for the same org+repo into one job", async () => {
    await enqueueRepoMapWarmJob(1, "acme-corp/backend");
    await enqueueRepoMapWarmJob(1, "acme-corp/backend");

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
  });

  it("keeps jobs for different orgs or repos independent", async () => {
    await enqueueRepoMapWarmJob(1, "acme-corp/backend");
    await enqueueRepoMapWarmJob(2, "acme-corp/backend");
    await enqueueRepoMapWarmJob(1, "acme-corp/frontend");

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/queue/src/__tests__/repo-map-warm-queue.test.ts --project queue-integration`
Expected: FAIL — `REPO_MAP_WARM_QUEUE_NAME` is not exported from `../index.js`

- [ ] **Step 3: Implement the queue**

In `packages/queue/src/index.ts`, add alongside the existing queue definitions:

```ts
export const REPO_MAP_WARM_QUEUE_NAME = "repo-map-warm";

export interface RepoMapWarmJobData {
  orgId: number;
  repoFullName: string;
}

const repoMapWarmQueue = new Queue<RepoMapWarmJobData>(REPO_MAP_WARM_QUEUE_NAME, { connection: queueConnection });

// jobId collapses duplicate warm requests for the same org+repo (e.g. an agent's and a team's
// defaultCodebase both naming it) into a single queued job.
export async function enqueueRepoMapWarmJob(orgId: number, repoFullName: string): Promise<void> {
  await repoMapWarmQueue.add(
    "warm-repo-map",
    { orgId, repoFullName },
    { jobId: `${orgId}:${repoFullName}` },
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/queue/src/__tests__/repo-map-warm-queue.test.ts --project queue-integration`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/index.ts packages/queue/src/__tests__/repo-map-warm-queue.test.ts
git commit -m "feat(queue): add repo-map-warm queue"
```

---

### Task 4: `resolveDefaultBranchSha` in scm-provider

**Files:**
- Modify: `apps/worker/src/scm-provider.ts`
- Modify: `apps/worker/src/__tests__/scm-provider.test.ts`

**Interfaces:**
- Consumes: nothing new — reuses the existing private `findInstallationForRepo`/`getInstallationToken` already in this file.
- Produces: `resolveDefaultBranchSha(orgId: number, repoFullName: string): Promise<string | undefined>` — consumed by Task 9's `warmRepoMap` to check cache before provisioning a sandbox.

- [ ] **Step 1: Write the failing test**

Add to `apps/worker/src/__tests__/scm-provider.test.ts` (reuses the `githubConnection`/`fakeSandbox` helpers and `listConnectionsMock`/env setup already in that file):

```ts
describe("resolveDefaultBranchSha", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    listConnectionsMock.mockReset();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("returns the default branch's HEAD sha for a repo the org can access", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ repositories: [{ full_name: "acme-org/platform" }] }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_api" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "abc123" }), { status: 200 })),
    );

    await expect(resolveDefaultBranchSha(1, "acme-org/platform")).resolves.toBe("abc123");
  });

  it("returns undefined when no installation can see the repo", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ repositories: [] }), { status: 200 })),
    );

    await expect(resolveDefaultBranchSha(1, "acme-org/platform")).resolves.toBeUndefined();
  });
});
```

Add `resolveDefaultBranchSha` to the destructured import at the top of the test file:

```ts
const {
  buildPullRequestBody,
  cloneIntoSandbox,
  fetchIssue,
  openDraftPullRequest,
  parseIssueReference,
  pushChangesIfDirty,
  resolveCloneTarget,
  resolveDefaultBranchSha,
} = await import("../scm-provider");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/worker/src/__tests__/scm-provider.test.ts`
Expected: FAIL — `resolveDefaultBranchSha` is undefined

- [ ] **Step 3: Implement `resolveDefaultBranchSha`**

Add to `apps/worker/src/scm-provider.ts`, after `fetchIssue` (same shape: resolve installation, mint a token, hit the API — no sandbox involved):

```ts
// Resolves a repo's default branch HEAD sha via the GitHub API alone, with no sandbox and no
// clone — used by the repo-map pre-warm job to check whether a commit is already cached before
// paying for a container. Mirrors openDraftPullRequest's own default-branch lookup.
export async function resolveDefaultBranchSha(orgId: number, repoFullName: string): Promise<string | undefined> {
  const installationId = await findInstallationForRepo(orgId, repoFullName);
  if (installationId === undefined) return undefined;

  const token = await getInstallationToken(installationId);
  const repoRes = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!repoRes.ok) {
    throw new Error(`GitHub API repo lookup failed: ${repoRes.status} ${await repoRes.text().catch(() => "")}`);
  }
  const { default_branch: branch } = (await repoRes.json()) as { default_branch: string };

  const commitRes = await fetch(`${GITHUB_API}/repos/${repoFullName}/commits/${branch}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!commitRes.ok) {
    throw new Error(`GitHub API commit lookup failed: ${commitRes.status} ${await commitRes.text().catch(() => "")}`);
  }
  const { sha } = (await commitRes.json()) as { sha: string };
  return sha;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/worker/src/__tests__/scm-provider.test.ts`
Expected: PASS (all scm-provider tests, including the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/scm-provider.ts apps/worker/src/__tests__/scm-provider.test.ts
git commit -m "feat(worker): add resolveDefaultBranchSha for repo-map pre-warm"
```

---

### Task 5: Repo-map generation script (sandbox image)

**Files:**
- Create: `apps/worker/sandbox-image/generate-repo-map.ts`
- Modify: `apps/worker/sandbox-image/Dockerfile`

**Interfaces:**
- Produces: a script invoked as `["/agent/node_modules/.bin/tsx", "/agent/generate-repo-map.ts"]` via `sandboxProvider.exec`, writing one `__RESULT__{"text":...,"costUsd":...,"tokens":...}` line to stdout — consumed by Task 7's `ensureRepoMap`.

No automated test for this file: like `run-turn.ts` (its direct precedent, also untested), it only runs inside a real container against the real Claude Agent SDK — `tsx` transpiles it without type-checking, and it's outside the pnpm workspace `apps/worker` typecheck covers. It's verified by the manual gate in Task 13.

- [ ] **Step 1: Write the script**

Create `apps/worker/sandbox-image/generate-repo-map.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// Prefixes the one line of stdout the worker parses (see apps/worker/src/repo-map.ts).
const RESULT_MARKER = "__RESULT__";

const PROMPT =
  "Explore this repository and produce a concise map for a coding agent that has never seen it " +
  "before: the directory structure and what each top-level area is for, key entry points, " +
  "build/test/lint commands, and any non-obvious conventions a new contributor would need. " +
  "Do not describe files one by one. Stay under 800 words.";

async function main(): Promise<void> {
  let resultText: string | undefined;
  let costUsd = 0;
  let tokens = 0;

  // No `thinking` option (unlike run-turn.ts) — this call's job is a quick orientation summary,
  // not careful reasoning, and thinking tokens would work against the "cheap and bounded" point
  // of running this on a fixed low-cost model in the first place.
  for await (const message of query({
    prompt: PROMPT,
    options: {
      model: "claude-haiku-4-5",
      cwd: "/workspace",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result;
        costUsd = message.total_cost_usd;
        tokens = message.usage.input_tokens + message.usage.output_tokens;
      } else {
        throw new Error(`Repo map generation failed: ${message.subtype} (${message.errors.join(", ") || "no details"})`);
      }
    }
  }

  if (resultText === undefined) {
    throw new Error("Claude Agent SDK query completed without a result message");
  }

  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ text: resultText, costUsd, tokens })}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Copy it into the sandbox image**

In `apps/worker/sandbox-image/Dockerfile`, add alongside the existing `COPY run-turn.ts ./`:

```dockerfile
COPY run-turn.ts ./
COPY generate-repo-map.ts ./
```

- [ ] **Step 3: Rebuild the image locally to confirm it builds**

Run:
```bash
docker build -t agentfactory-sandbox:local apps/worker/sandbox-image
```
Expected: build succeeds (same `npm install` layer as before, just one more `COPY`).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/sandbox-image/generate-repo-map.ts apps/worker/sandbox-image/Dockerfile
git commit -m "feat(sandbox-image): add repo-map generation script"
```

---

### Task 6: `composeSystemPrompt` gains a repo-map slot

**Files:**
- Modify: `apps/worker/src/prompt-composition.ts`
- Modify: `apps/worker/src/__tests__/prompt-composition.test.ts`

**Interfaces:**
- Produces: `composeSystemPrompt(teamContextPrefix: string, repoMap: string, agentSystemPrompt: string): string` (signature change — was 2 args, now 3) — consumed by Task 8's `worker.ts` wiring.

- [ ] **Step 1: Write the failing test**

Update `apps/worker/src/__tests__/prompt-composition.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PLATFORM_PREAMBLE, composeSystemPrompt, hashPrompt } from "../prompt-composition";

describe("composeSystemPrompt", () => {
  it("orders platform preamble, then team context, then repo map, then agent system prompt", () => {
    const result = composeSystemPrompt(
      "## Team Context\n\nUse pnpm.\n\n---\n\n",
      "## Repo Map\n\nThis is a monorepo.",
      "You are a reviewer.",
    );

    const preambleIndex = result.indexOf(PLATFORM_PREAMBLE);
    const teamIndex = result.indexOf("Use pnpm.");
    const repoMapIndex = result.indexOf("This is a monorepo.");
    const agentIndex = result.indexOf("You are a reviewer.");

    expect(preambleIndex).toBe(0);
    expect(teamIndex).toBeGreaterThan(preambleIndex);
    expect(repoMapIndex).toBeGreaterThan(teamIndex);
    expect(agentIndex).toBeGreaterThan(repoMapIndex);
  });

  it("still leads with the platform preamble when there is no team context or repo map", () => {
    const result = composeSystemPrompt("", "", "You are a reviewer.");
    expect(result).toBe(PLATFORM_PREAMBLE + "You are a reviewer.");
  });

  it("omits the repo map cleanly when empty, without changing prior behavior", () => {
    const result = composeSystemPrompt("## Team Context\n\nUse pnpm.\n\n---\n\n", "", "You are a reviewer.");
    expect(result).toBe(PLATFORM_PREAMBLE + "## Team Context\n\nUse pnpm.\n\n---\n\n" + "You are a reviewer.");
  });
});

describe("hashPrompt", () => {
  it("matches a plain sha256 hex digest of the input", () => {
    expect(hashPrompt("hello")).toBe(createHash("sha256").update("hello").digest("hex"));
  });

  it("produces different hashes for different prompts", () => {
    expect(hashPrompt("a")).not.toBe(hashPrompt("b"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/worker/src/__tests__/prompt-composition.test.ts`
Expected: FAIL — `composeSystemPrompt` called with 3 args but declared to take 2 (or the ordering assertions fail once it's called with 3 and the extra arg is ignored)

- [ ] **Step 3: Implement**

In `apps/worker/src/prompt-composition.ts`:

```ts
// Order per ARCHITECTURE.md §3, extended with the repo map (docs/superpowers/specs/
// 2026-08-23-repo-map-indexing-design.md) between team context and the agent's own prompt —
// narrowed to this repo's actual scope: no retrieved context items, no skills index yet.
export function composeSystemPrompt(teamContextPrefix: string, repoMap: string, agentSystemPrompt: string): string {
  return PLATFORM_PREAMBLE + teamContextPrefix + repoMap + agentSystemPrompt;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/worker/src/__tests__/prompt-composition.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/prompt-composition.ts apps/worker/src/__tests__/prompt-composition.test.ts
git commit -m "feat(worker): add repo map slot to composeSystemPrompt"
```

---

### Task 7: `ensureRepoMap` (run-time cache/generate path)

**Files:**
- Create: `apps/worker/src/repo-map.ts`
- Create: `apps/worker/src/__tests__/repo-map.test.ts`

**Interfaces:**
- Consumes: `getRepoMap`, `insertRepoMap` from `@agentfactory/db` (Task 1); `SandboxProvider` from `./sandbox/types`.
- Produces: `ensureRepoMap(sandboxProvider: SandboxProvider, sandboxId: string, orgId: number, repoFullName: string): Promise<string>` — consumed by Task 8 (run pipeline) and Task 9 (`warmRepoMap`).

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/repo-map.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";

const getRepoMapMock = vi.fn();
const insertRepoMapMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getRepoMap: (...args: unknown[]) => getRepoMapMock(...args),
  insertRepoMap: (...args: unknown[]) => insertRepoMapMock(...args),
}));

const { ensureRepoMap } = await import("../repo-map");

function fakeSandbox(execResults: Record<string, OutputChunk[]>): SandboxProvider {
  return {
    create: vi.fn(),
    exec: (async function* (id: string, cmd: string[]) {
      const key = cmd.join(" ");
      const chunks = execResults[key];
      if (!chunks) throw new Error(`No fake exec result registered for: ${key}`);
      for (const chunk of chunks) yield chunk;
    }) as SandboxProvider["exec"],
    writeFiles: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    resetMemory: vi.fn(),
  };
}

const HEAD_CMD = "git -C /workspace rev-parse HEAD";
const GENERATE_CMD = "/agent/node_modules/.bin/tsx /agent/generate-repo-map.ts";

describe("ensureRepoMap", () => {
  it("returns the cached map without invoking the generation script on a cache hit", async () => {
    getRepoMapMock.mockReset().mockResolvedValue({ content: "cached map" });
    insertRepoMapMock.mockReset();
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
    });

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");

    expect(result).toBe("cached map");
    expect(getRepoMapMock).toHaveBeenCalledWith(1, "acme/widgets", "abc123");
    expect(insertRepoMapMock).not.toHaveBeenCalled();
  });

  it("generates and caches a map on a cache miss", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset().mockResolvedValue(undefined);
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
      [GENERATE_CMD]: [
        { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "generated map", costUsd: 0.01, tokens: 500 })}\n` },
      ],
    });

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");

    expect(result).toBe("generated map");
    expect(insertRepoMapMock).toHaveBeenCalledWith({
      orgId: 1,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "generated map",
      generationCostUsd: 0.01,
      generationTokens: 500,
    });
  });

  it("returns an empty string without throwing when generation produces no result line", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset();
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
      [GENERATE_CMD]: [{ stream: "stderr", data: "container crashed\n" }],
    });

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");

    expect(result).toBe("");
    expect(insertRepoMapMock).not.toHaveBeenCalled();
  });

  it("returns an empty string without throwing when the generation exec itself throws", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset();
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: (async function* (_id: string, cmd: string[]) {
        if (cmd.join(" ") === HEAD_CMD) {
          yield { stream: "stdout", data: "abc123\n" } as OutputChunk;
          return;
        }
        throw new Error("sandbox exec failed");
      }) as SandboxProvider["exec"],
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");
    expect(result).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/worker/src/__tests__/repo-map.test.ts`
Expected: FAIL — `Cannot find module '../repo-map'`

- [ ] **Step 3: Implement `ensureRepoMap`**

Create `apps/worker/src/repo-map.ts`:

```ts
import { getRepoMap, insertRepoMap } from "@agentfactory/db";
import type { SandboxProvider } from "./sandbox/types";

const RESULT_MARKER = "__RESULT__";

interface GeneratedMap {
  text: string;
  costUsd: number;
  tokens: number;
}

async function execToString(sandboxProvider: SandboxProvider, sandboxId: string, cmd: string[]): Promise<string> {
  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, cmd)) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }
  return stdout;
}

async function getSandboxHeadSha(sandboxProvider: SandboxProvider, sandboxId: string): Promise<string> {
  const stdout = await execToString(sandboxProvider, sandboxId, ["git", "-C", "/workspace", "rev-parse", "HEAD"]);
  return stdout.trim();
}

// Runs the one-shot generation turn (apps/worker/sandbox-image/generate-repo-map.ts) in the
// sandbox that already has the repo checked out. Returns undefined on any failure — caller
// treats that identically to "no map available", never throws further up.
async function generateRepoMap(sandboxProvider: SandboxProvider, sandboxId: string): Promise<GeneratedMap | undefined> {
  try {
    const stdout = await execToString(sandboxProvider, sandboxId, [
      "/agent/node_modules/.bin/tsx",
      "/agent/generate-repo-map.ts",
    ]);
    const resultLine = stdout.split("\n").find((line) => line.startsWith(RESULT_MARKER));
    if (!resultLine) return undefined;
    return JSON.parse(resultLine.slice(RESULT_MARKER.length)) as GeneratedMap;
  } catch (err) {
    console.error("Repo map generation failed:", err);
    return undefined;
  }
}

// Run-time path: called from the run pipeline right after clone, with a sandbox that already
// has the target repo checked out. Cache key is the exact commit sha being worked on — see
// docs/superpowers/specs/2026-08-23-repo-map-indexing-design.md's "Design decisions" for why
// this (not repoFullName alone, not a merge-base) is the invalidation mechanism. Never throws:
// any failure here falls back to "" (no map), and the run proceeds exactly as it did before
// this feature existed.
export async function ensureRepoMap(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  orgId: number,
  repoFullName: string,
): Promise<string> {
  const sha = await getSandboxHeadSha(sandboxProvider, sandboxId);
  const cached = await getRepoMap(orgId, repoFullName, sha);
  if (cached) return cached.content;

  const generated = await generateRepoMap(sandboxProvider, sandboxId);
  if (!generated) return "";

  await insertRepoMap({
    orgId,
    repoFullName,
    commitSha: sha,
    content: generated.text,
    generationCostUsd: generated.costUsd,
    generationTokens: generated.tokens,
  });
  return generated.text;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/worker/src/__tests__/repo-map.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/repo-map.ts apps/worker/src/__tests__/repo-map.test.ts
git commit -m "feat(worker): add ensureRepoMap run-time cache/generate path"
```

---

### Task 8: Wire `ensureRepoMap` into the run pipeline

**Files:**
- Modify: `apps/worker/src/worker.ts`

**Interfaces:**
- Consumes: `ensureRepoMap` from `./repo-map` (Task 7), `cloneIntoSandbox` from `./scm-provider` (already imported), the widened `composeSystemPrompt` (Task 6).

No new automated test — `worker.ts` has no existing unit test file (it's the BullMQ job handler itself; `agent-runtime.test.ts`/`scm-provider.test.ts`/`prompt-composition.test.ts` already cover the pieces it calls). Verified by `pnpm typecheck` and the manual gate in Task 13.

- [ ] **Step 1: Move the clone earlier and call `ensureRepoMap`**

`ensureRepoMap` needs `git rev-parse HEAD` inside the sandbox, but today the clone happens inside `runAgentTurn` (`apps/worker/src/agent-runtime.ts:42-44`), which runs *after* `composeSystemPrompt` in `worker.ts`. `cloneIntoSandbox` is already idempotent (it detects an existing checkout of the same repo and returns `ALREADY_CLONED`), so calling it once here and letting `runAgentTurn`'s internal call no-op is safe.

In `apps/worker/src/worker.ts`, add the import:

```ts
import { ensureRepoMap } from "./repo-map";
```

Replace the block from `const task = await getTaskBySessionId(session.id);` through the `if (task?.codebase) { ... }` (lines 92–101) with:

```ts
      const task = await getTaskBySessionId(session.id);
      let workspace: CloneTarget | undefined;
      let repoMap = "";
      if (task?.codebase) {
        workspace = await resolveCloneTarget(agent.orgId, task.codebase, `agent/session-${session.id}`);
        if (!workspace) {
          throw new Error(
            `Task ${task.ref}'s codebase "${task.codebase}" isn't accessible via any connected GitHub installation`,
          );
        }
        await cloneIntoSandbox(sandboxProvider, sandboxId, workspace);
        repoMap = await ensureRepoMap(sandboxProvider, sandboxId, agent.orgId, workspace.repoFullName);
      }
```

- [ ] **Step 2: Pass the repo map into `composeSystemPrompt`**

Replace:

```ts
      const systemPrompt = composeSystemPrompt(teamContextPrefix, agent.systemPrompt);
```

with:

```ts
      const systemPrompt = composeSystemPrompt(teamContextPrefix, repoMap, agent.systemPrompt);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: no errors (`cloneIntoSandbox` is already imported in this file; `CloneTarget` is already an imported type).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/worker.ts
git commit -m "feat(worker): wire ensureRepoMap into the run pipeline"
```

---

### Task 9: `warmRepoMap` (pre-warm path)

**Files:**
- Modify: `apps/worker/src/repo-map.ts`
- Modify: `apps/worker/src/__tests__/repo-map.test.ts`

**Interfaces:**
- Consumes: `resolveDefaultBranchSha` (Task 4), `cloneIntoSandbox`, `resolveCloneTarget` (existing `scm-provider.ts`), `ensureRepoMap` (Task 7, same file).
- Produces: `warmRepoMap(sandboxProvider: SandboxProvider, orgId: number, repoFullName: string, sandboxImage: string): Promise<void>` — consumed by Task 10's queue processor.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/__tests__/repo-map.test.ts`. First, extend the `@agentfactory/db` mock and add an `scm-provider` mock at the top of the file (alongside the existing `@agentfactory/db` mock):

```ts
const resolveDefaultBranchShaMock = vi.fn();
const resolveCloneTargetMock = vi.fn();
const cloneIntoSandboxMock = vi.fn();
// Path is relative to this test file, not to repo-map.ts — Vitest resolves vi.mock specifiers
// against the calling module, and both resolve to the same apps/worker/src/scm-provider.ts.
vi.mock("../scm-provider", () => ({
  resolveDefaultBranchSha: (...args: unknown[]) => resolveDefaultBranchShaMock(...args),
  resolveCloneTarget: (...args: unknown[]) => resolveCloneTargetMock(...args),
  cloneIntoSandbox: (...args: unknown[]) => cloneIntoSandboxMock(...args),
}));
```

and change the import line to also pull in `warmRepoMap`:

```ts
const { ensureRepoMap, warmRepoMap } = await import("../repo-map");
```

Then add:

```ts
describe("warmRepoMap", () => {
  it("never creates a sandbox when the default branch's sha is already cached", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue({ content: "cached" });
    const create = vi.fn();
    const sandbox: SandboxProvider = {
      create,
      exec: vi.fn(),
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local");

    expect(create).not.toHaveBeenCalled();
  });

  it("provisions, clones, generates, and tears down on a cache miss", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset().mockResolvedValue(undefined);
    resolveCloneTargetMock.mockReset().mockResolvedValue({
      cloneUrl: "https://x-access-token:tok@github.com/acme/widgets.git",
      branch: "main",
      repoFullName: "acme/widgets",
      installationId: 1,
    });
    cloneIntoSandboxMock.mockReset().mockResolvedValue(undefined);
    const destroy = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: "warm-sandbox-1" });
    const sandbox: SandboxProvider = {
      create,
      exec: (async function* (_id: string, cmd: string[]) {
        if (cmd.join(" ") === "git -C /workspace rev-parse HEAD") {
          yield { stream: "stdout", data: "abc123\n" } as OutputChunk;
          return;
        }
        yield {
          stream: "stdout",
          data: `__RESULT__${JSON.stringify({ text: "warmed map", costUsd: 0, tokens: 100 })}\n`,
        } as OutputChunk;
      }) as SandboxProvider["exec"],
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy,
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local");

    expect(create).toHaveBeenCalledWith({ image: "agentfactory-sandbox:local", env: expect.any(Object) });
    expect(cloneIntoSandboxMock).toHaveBeenCalled();
    expect(insertRepoMapMock).toHaveBeenCalledWith(expect.objectContaining({ content: "warmed map" }));
    expect(destroy).toHaveBeenCalledWith("warm-sandbox-1");
  });

  it("still tears down the sandbox when clone fails after it was created", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    resolveCloneTargetMock.mockReset().mockResolvedValue({
      cloneUrl: "https://x-access-token:tok@github.com/acme/widgets.git",
      branch: "main",
      repoFullName: "acme/widgets",
      installationId: 1,
    });
    cloneIntoSandboxMock.mockReset().mockRejectedValue(new Error("clone failed"));
    const destroy = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: "warm-sandbox-2" });
    const sandbox: SandboxProvider = {
      create,
      exec: vi.fn(),
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy,
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await expect(warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local")).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledWith("warm-sandbox-2");
  });

  it("does not throw when destroy itself fails after a generation error", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    resolveCloneTargetMock.mockReset().mockResolvedValue({
      cloneUrl: "https://x-access-token:tok@github.com/acme/widgets.git",
      branch: "main",
      repoFullName: "acme/widgets",
      installationId: 1,
    });
    cloneIntoSandboxMock.mockReset().mockResolvedValue(undefined);
    const destroy = vi.fn().mockRejectedValue(new Error("docker teardown failed"));
    const create = vi.fn().mockResolvedValue({ id: "warm-sandbox-3" });
    const sandbox: SandboxProvider = {
      create,
      exec: (async function* () {
        yield { stream: "stderr", data: "boom\n" } as OutputChunk;
      }) as SandboxProvider["exec"],
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy,
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await expect(warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local")).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledWith("warm-sandbox-3");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/worker/src/__tests__/repo-map.test.ts`
Expected: FAIL — `warmRepoMap` is not exported from `../repo-map`

- [ ] **Step 3: Implement `warmRepoMap`**

Add to `apps/worker/src/repo-map.ts` (extend the existing imports at the top with `resolveDefaultBranchSha`, `resolveCloneTarget`, `cloneIntoSandbox` from `./scm-provider`):

```ts
import { cloneIntoSandbox, resolveCloneTarget, resolveDefaultBranchSha } from "./scm-provider";
```

```ts
// Pre-warm path: called when an agent's or team's defaultCodebase is set (apps/web's agent/team
// routes enqueue this via @agentfactory/queue's repo-map-warm queue). Resolves the default
// branch's current sha via the GitHub API alone first — no sandbox needed at all when that
// commit is already cached. On a miss, provisions a throwaway sandbox solely for this job and
// always tears it down, even when clone or generation fails partway through, so a failure here
// never leaks a container. Best-effort like ensureRepoMap: never throws, since a failed warm job
// just means the first real run pays the generation cost, exactly as if this feature didn't run.
export async function warmRepoMap(
  sandboxProvider: SandboxProvider,
  orgId: number,
  repoFullName: string,
  sandboxImage: string,
): Promise<void> {
  try {
    const sha = await resolveDefaultBranchSha(orgId, repoFullName);
    if (!sha) return;
    if (await getRepoMap(orgId, repoFullName, sha)) return;

    const workspace = await resolveCloneTarget(orgId, repoFullName, "main");
    if (!workspace) return;

    const sandbox = await sandboxProvider.create({ image: sandboxImage, env: {} });
    try {
      await cloneIntoSandbox(sandboxProvider, sandbox.id, workspace);
      await ensureRepoMap(sandboxProvider, sandbox.id, orgId, repoFullName);
    } finally {
      await sandboxProvider.destroy(sandbox.id).catch((err) => {
        console.error(`Failed to tear down warm sandbox ${sandbox.id} for ${repoFullName}:`, err);
      });
    }
  } catch (err) {
    console.error(`Repo map pre-warm failed for ${repoFullName}:`, err);
  }
}
```

Note: `resolveCloneTarget(orgId, repoFullName, "main")` uses a fixed branch name only for minting the clone URL/token — `cloneIntoSandbox` doesn't check out `"main"` literally when it clones (see its script: a fresh clone runs `git checkout -b "$BRANCH_NAME"` from whatever HEAD the plain `git clone` already checked out, which is the repo's actual default branch — the branch name here only matters for the new local branch it creates, which this throwaway sandbox discards anyway). This is fine for the warm path since the sandbox is never pushed to or reused.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/worker/src/__tests__/repo-map.test.ts`
Expected: PASS (8 tests total: 4 from Task 7 + 4 new)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/repo-map.ts apps/worker/src/__tests__/repo-map.test.ts
git commit -m "feat(worker): add warmRepoMap pre-warm path"
```

---

### Task 10: Warm-queue processor in the worker

**Files:**
- Modify: `apps/worker/src/worker.ts`

**Interfaces:**
- Consumes: `warmRepoMap` (Task 9), `REPO_MAP_WARM_QUEUE_NAME`, `RepoMapWarmJobData` from `@agentfactory/queue` (Task 3).

No new automated test — matches the existing `sandboxTeardownWorker` processor in this file, which also has no dedicated unit test (BullMQ processors here are verified by the manual gate).

- [ ] **Step 1: Register the processor**

In `apps/worker/src/worker.ts`, widen the `@agentfactory/queue` import:

```ts
import {
  RUN_QUEUE_NAME,
  REPO_MAP_WARM_QUEUE_NAME,
  SANDBOX_TEARDOWN_QUEUE_NAME,
  queueConnection,
  type RepoMapWarmJobData,
  type RunJobData,
  type SandboxTeardownJobData,
} from "@agentfactory/queue";
```

and the `./repo-map` import:

```ts
import { ensureRepoMap, warmRepoMap } from "./repo-map";
```

Add the new worker after `sandboxTeardownWorker` (before the final `console.log`):

```ts
// Triggered when an agent's or team's defaultCodebase is set (apps/web's agent/team routes) —
// best-effort pre-warm so the first real task against that repo doesn't pay the generation cost
// synchronously. Never touches runs/sessions/events; failures are logged, not surfaced anywhere.
const repoMapWarmWorker = new Worker<RepoMapWarmJobData>(
  REPO_MAP_WARM_QUEUE_NAME,
  async (job) => {
    const { orgId, repoFullName } = job.data;
    await warmRepoMap(sandboxProvider, orgId, repoFullName, SANDBOX_IMAGE);
  },
  { connection: queueConnection },
);

repoMapWarmWorker.on("failed", (job, err) => {
  console.error(`Repo map warm job ${job?.id} failed:`, err);
});
```

- [ ] **Step 2: Update the startup log line**

```ts
console.log(
  `apps/worker listening on queues "${RUN_QUEUE_NAME}", "${SANDBOX_TEARDOWN_QUEUE_NAME}", "${REPO_MAP_WARM_QUEUE_NAME}"`,
);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/worker.ts
git commit -m "feat(worker): register repo-map-warm queue processor"
```

---

### Task 11: Trigger pre-warm from agent routes

**Files:**
- Modify: `apps/web/src/app/api/agents/route.ts`
- Modify: `apps/web/src/app/api/agents/[agentId]/route.ts`

**Interfaces:**
- Consumes: `enqueueRepoMapWarmJob` from `@agentfactory/queue` (Task 3).

No new automated test — this codebase has no existing unit tests for API route handlers (only `apps/web/src/lib`/`apps/web/src/server` helpers are unit-tested); verified by the manual gate in Task 13, matching the existing untested status of every other route in these two files.

- [ ] **Step 1: Enqueue on agent creation**

In `apps/web/src/app/api/agents/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createAgent, listAgents } from "@agentfactory/db";
import { isValidModelId, isValidOverflowPolicy } from "@agentfactory/core";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listAgents(ctx.orgId));
}

export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  if (body.model !== undefined && !isValidModelId(body.model)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  if (body.onContextOverflow !== undefined && !isValidOverflowPolicy(body.onContextOverflow)) {
    return NextResponse.json({ error: "Invalid onContextOverflow value" }, { status: 400 });
  }
  const agent = await createAgent(ctx.orgId, body);
  if (agent.defaultCodebase) {
    await enqueueRepoMapWarmJob(ctx.orgId, agent.defaultCodebase);
  }
  return NextResponse.json(agent, { status: 201 });
}
```

- [ ] **Step 2: Enqueue on agent update**

In `apps/web/src/app/api/agents/[agentId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { deleteAgent, getAgent, updateAgent } from "@agentfactory/db";
import { isValidModelId, isValidOverflowPolicy } from "@agentfactory/core";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

// Requires a logged-in user but doesn't yet verify agentId belongs to their org — same
// documented tenant-isolation gap as messages/RLS in packages/db/src/schema.ts, not new here.
export async function PATCH(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { agentId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (body.model !== undefined && !isValidModelId(body.model)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  if (body.onContextOverflow !== undefined && !isValidOverflowPolicy(body.onContextOverflow)) {
    return NextResponse.json({ error: "Invalid onContextOverflow value" }, { status: 400 });
  }
  const agent = await updateAgent(Number(agentId), body);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (typeof body.defaultCodebase === "string" && body.defaultCodebase) {
    await enqueueRepoMapWarmJob(agent.orgId, body.defaultCodebase);
  }
  return NextResponse.json(agent);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;
  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await deleteAgent(Number(agentId));
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/agents/route.ts apps/web/src/app/api/agents/[agentId]/route.ts
git commit -m "feat(web): trigger repo-map pre-warm from agent defaultCodebase"
```

---

### Task 12: Team `defaultCodebase` — route, context, and UI

**Files:**
- Modify: `apps/web/src/app/api/teams/route.ts`
- Modify: `apps/web/src/app/api/teams/[teamId]/route.ts`
- Modify: `apps/web/src/lib/mock/context.tsx`
- Modify: `apps/web/src/app/(app)/teams-v2/page.tsx`
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts`

**Interfaces:**
- Consumes: `enqueueRepoMapWarmJob` (Task 3), widened `createTeam`/`updateTeam` (Task 2).

No new automated test, same reasoning as Task 11 (no existing route-handler tests in this codebase) plus no existing component tests for `teams-v2/page.tsx`. Verified by the manual gate in Task 13.

- [ ] **Step 1: Enqueue on team creation**

In `apps/web/src/app/api/teams/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createTeam, listTeams } from "@agentfactory/db";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listTeams(ctx.orgId));
}

export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const team = await createTeam(ctx.orgId, body.name, body.description ?? "", body.defaultCodebase);
  if (team.defaultCodebase) {
    await enqueueRepoMapWarmJob(ctx.orgId, team.defaultCodebase);
  }
  return NextResponse.json(team, { status: 201 });
}
```

- [ ] **Step 2: Enqueue on team update**

In `apps/web/src/app/api/teams/[teamId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { updateTeam } from "@agentfactory/db";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

// Requires a logged-in user but doesn't yet verify teamId belongs to their org — same
// documented tenant-isolation gap as messages/RLS in packages/db/src/schema.ts, not new here.
export async function PATCH(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { teamId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const team = await updateTeam(Number(teamId), body);
  if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
  if (typeof body.defaultCodebase === "string" && body.defaultCodebase) {
    await enqueueRepoMapWarmJob(team.orgId, body.defaultCodebase);
  }
  return NextResponse.json(team);
}
```

- [ ] **Step 3: Widen `createTeam` in the client-side mock backend context**

In `apps/web/src/lib/mock/context.tsx`, widen the interface and implementation:

```ts
  createTeam: (name: string, description: string, defaultCodebase?: string) => Promise<Team>;
```

```ts
  const createTeam = useCallback(
    async (name: string, description: string, defaultCodebase?: string) => {
      const team = await apiFetch<Team>("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name, description, defaultCodebase }),
      });
      setState((s) => ({ ...s, teams: [...s.teams, team] }));
      showToast("toast.teamCreated");
      return team;
    },
    [showToast],
  );
```

- [ ] **Step 4: Add the repo selector to `NewTeamPanel`**

In `apps/web/src/app/(app)/teams-v2/page.tsx`, add the `apiFetch` import:

```ts
import { apiFetch } from "@/lib/api-client";
```

Update `NewTeamPanel` to fetch connected repos and add the field (mirrors `AgentFormModal`'s repo `<select>`, reusing this file's existing `selectClassName` constant):

```tsx
function NewTeamPanel({ onCreated, onCancel }: {
  onCreated: (teamId: number) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { createTeam } = useMockBackend();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultCodebase, setDefaultCodebase] = useState("");
  const [repos, setRepos] = useState<{ id: number; fullName: string }[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [nameError, setNameError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ id: number; fullName: string }[]>("/api/connections/github/repos")
      .then((result) => {
        if (!cancelled) setRepos(result);
      })
      .finally(() => {
        if (!cancelled) setReposLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setNameError(true); return; }
    setSaving(true);
    try {
      const team = await createTeam(name.trim(), description.trim(), defaultCodebase || undefined);
      onCreated(team.id);
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onCancel();
  }

  return (
    <form onSubmit={handleCreate} onKeyDown={handleKeyDown} className="mt-6 rounded-[var(--radius-md)] border border-[var(--color-divider)] overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--color-divider)]">
        <span className="text-2xl leading-none">🏢</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[var(--color-neutral-100)]">{t("teamsV2.newTeamTitle")}</div>
          <div className="text-xs text-[var(--color-neutral-500)]">{t("teamsV2.newTeamSubtitle")}</div>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.teamNameLabel")}
          </label>
          <TextInput
            autoFocus
            placeholder={t("teamsV2.teamNamePlaceholder")}
            value={name}
            onChange={(e) => { setName(e.target.value); if (nameError) setNameError(false); }}
            maxLength={80}
          />
          {nameError && (
            <p className="mt-1 text-xs text-red-400">{t("teamsV2.nameRequired")}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.teamDescriptionLabel")}
          </label>
          <TextInput
            placeholder={t("teamsV2.teamDescriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.teamDefaultCodebaseLabel")}
          </label>
          <select
            value={defaultCodebase}
            onChange={(e) => setDefaultCodebase(e.target.value)}
            className={selectClassName}
          >
            <option value="">
              {reposLoading ? t("teamsV2.teamDefaultCodebaseLoading") : t("teamsV2.teamDefaultCodebasePlaceholder")}
            </option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs text-[var(--color-neutral-600)]">
            {t("teamsV2.teamDefaultCodebaseHelp")}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--color-divider)]">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? t("teamsV2.creatingTeam") : t("teamsV2.createTeam")}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Add the i18n strings**

In `apps/web/src/lib/i18n/dictionaries/en.ts`, add near the other `team*Label` keys in the `teamsV2` section (after `teamDescriptionPlaceholder`):

```ts
    teamDefaultCodebaseLabel: "Default codebase",
    teamDefaultCodebasePlaceholder: "Select a repository (optional)…",
    teamDefaultCodebaseLoading: "Loading repositories…",
    teamDefaultCodebaseHelp: "Has no effect on which repo agents use — only pre-warms this repo's map so tasks against it start faster.",
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors (the `TranslationKey` type picks up the new keys automatically from `en.ts`, per this repo's i18n convention)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/api/teams/route.ts apps/web/src/app/api/teams/[teamId]/route.ts apps/web/src/lib/mock/context.tsx "apps/web/src/app/(app)/teams-v2/page.tsx" apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): add team defaultCodebase field and repo-map pre-warm trigger"
```

---

### Task 13: Full-suite verification and manual gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run:
```bash
pnpm typecheck && pnpm --filter @agentfactory/db test && pnpm --filter @agentfactory/queue test && pnpm --filter @agentfactory/worker test
```
Expected: all green — this exercises every test added in Tasks 1–7 and 9, plus the full existing suite (regression check for the `composeSystemPrompt` signature change touching `worker.ts`'s only other caller, `agent-runtime.ts`, which is unaffected since it doesn't call `composeSystemPrompt` directly).

- [ ] **Step 2: Rebuild the sandbox image**

Run:
```bash
docker build -t agentfactory-sandbox:local apps/worker/sandbox-image
```
Expected: succeeds, includes `generate-repo-map.ts` (Task 5).

- [ ] **Step 3: Manual end-to-end check (per the spec's verification gate)**

With the dev stack running (`pnpm dev` / `scripts/dev-all.sh`, Postgres and Redis up, a real GitHub App connection configured):

1. Create or edit an agent, setting **Default codebase** to a real connected repo. Confirm a row appears in `repo_maps` for that repo (query: `select repo_full_name, commit_sha, length(content) from repo_maps;`) **without** starting any run — this proves the pre-warm path (Tasks 9–11) fired on its own.
2. Create a task against that same repo and run it. Confirm the run completes normally.
3. `delete from repo_maps;` for that repo, then run the same task again. Confirm a new row reappears afterward, and compare `runs.prompt_hash` between the two runs — it must differ, proving the repo map is actually folded into the composed system prompt (Task 8), not inert.
4. Repeat step 1 for a **team's** Default codebase field (Task 12) and confirm the same pre-warm behavior.

- [ ] **Step 4: No commit for this task** — it's verification only; if any step surfaces a bug, fix it in the relevant task's files and re-run that task's own test suite before returning here.
