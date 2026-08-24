# Repo map indexing — design spec

**Date:** 2026-08-23
**Status:** approved

## Problem

Every run clones the target repo fresh into a sandbox (`apps/worker/src/scm-provider.ts` → `apps/worker/src/agent-runtime.ts`) and hands the Claude Agent SDK its full default toolset with no memory of that repo's structure (`apps/worker/sandbox-image/run-turn.ts` runs with `permissionMode: "bypassPermissions"` and no `tools` restriction). The agent re-discovers directory layout, key modules, and conventions via Glob/Grep/Read on every single run — the same rediscovery this repo's own `CLAUDE.md` exists to shortcut for interactive Claude Code sessions. That rediscovery cost is paid repeatedly against the same, mostly-unchanged code.

## Goal

Auto-generate a CLAUDE.md-style "repo map" per repo, cache it keyed to the exact commit it describes, and inject it into a run's system prompt the same way `team.shared_context` already is — so an agent starts oriented instead of exploring from zero. Additionally, pre-warm the cache ahead of time when a repo is assigned to an agent or team, so the first real task against a repo doesn't pay the generation cost synchronously.

## Ground truth this design relies on

- **The sandbox already runs the full Agent SDK toolset against a live clone.** `run-turn.ts` calls `query()` with `cwd: "/workspace"`, `bypassPermissions`, no tool restriction — it is capable of exploring a repo exactly the way a human Claude Code session would.
- **Clone happens once per session, not once per turn.** `worker.ts`'s `ensureSandbox` reuses a session's warm container across its runs; re-cloning would wipe uncommitted changes (comment in `scm-provider.ts`). So any repo-map step that hooks into the clone point runs once per session, not once per turn.
- **The system prompt is already composed host-side, not SDK-side**, per ARCHITECTURE.md §3: `composeSystemPrompt(teamContextPrefix, agent.systemPrompt)` in `worker.ts:138`, and the result is passed into `run-turn.ts` via a `SYSTEM_PROMPT` env var. There is precedent for exactly the kind of injection this design needs.
- **`teams.shared_context` is the existing precedent for "small, hot, always-injected text"** (`packages/db/src/schema.ts:75-77`, 64 KB cap, enforced both at the API and as a `CHECK` constraint) — the pattern this design's cache table follows, at a smaller cap.
- **No webhook/trigger bus exists yet** (`docs/PRODUCT-DEFINITION.md` / ARCHITECTURE.md §2.6, §5 — trigger bus is M5). Push-based cache invalidation isn't available; invalidation has to be derived some other way.
- **`agents.defaultCodebase`** (text, nullable) is the only existing "repo assigned to X" concept in the schema; `tasks.codebase` is a per-task override. **`teams` has no repo field today** — `sharedContext`, `githubTeamSlug`, `name`, `description` only (`packages/db/src/schema.ts:66-85`).
- **`packages/queue`** already has the exact shape needed for "web wants the worker to do something Docker-related it can't do itself": `SANDBOX_TEARDOWN_QUEUE_NAME`, enqueued by web, processed by worker (`packages/queue/src/index.ts`).
- **`scm-provider.ts` already resolves which GitHub installation covers a given `repoFullName`** for an org (`findInstallationForRepo`), and already mints short-lived per-clone installation tokens — reused as-is for both the run-time and pre-warm paths.
- **Runs are non-blocking and side-effect-cautious by design** (ARCHITECTURE.md §4, §6): no approval gates, no automatic retries on anything that could have pushed/commented already. A repo-map read-only clone has no such side effects, so retry rules for it are looser than for real runs.

## Scope

- `packages/db/src/schema.ts` — new `repo_maps` table; new nullable `teams.defaultCodebase` column.
- `apps/worker/src/repo-map.ts` (new) — `ensureRepoMap` (core generation/cache logic, used by both the run pipeline and the warm job) and `warmRepoMap` (pre-warm entry point).
- `apps/worker/src/prompt-composition.ts` — `composeSystemPrompt` gains a `repoMap` parameter, slotted between `teamContextPrefix` and `agentSystemPrompt`.
- `apps/worker/src/worker.ts` — call `ensureRepoMap` right after clone in the run pipeline; pass its result into `composeSystemPrompt`.
- `apps/worker/src/worker.ts` (or a new processor module) — BullMQ processor for the new warm queue.
- `packages/queue/src/index.ts` — new `REPO_MAP_WARM_QUEUE_NAME` queue + `enqueueRepoMapWarmJob`.
- `apps/web/src/app/api/agents/**` — enqueue a warm job when `defaultCodebase` is set/changed to non-empty.
- `apps/web/src/app/api/teams/**` — same, for the new `defaultCodebase` field; UI field to set it (mirrors the existing agent codebase selector pattern).
- Tests: `apps/worker/src/__tests__/repo-map.test.ts` (new), `prompt-composition.test.ts` (extended).

## Out of scope

- **Any queryable/on-demand code index** (symbol search, embeddings, an MCP tool the agent calls). This design is a flat, pre-generated map injected wholesale — the alternative considered and rejected for now, since it needs real indexing infrastructure this repo doesn't have yet. Revisit if flat maps stop fitting the size cap on large monorepos.
- **Push-triggered regeneration.** No webhook/trigger bus exists; regeneration is derived lazily from the commit sha instead (see Design decisions).
- **Agents inheriting a team's `defaultCodebase`.** The new team field only stores a repo and triggers warming — it has no effect on which repo an agent or task actually uses. Task/agent repo resolution is unchanged.
- **Any change to `agents.defaultCodebase`'s existing behavior or UI** beyond adding the warm-job trigger on write.
- **Pruning old `repo_maps` rows.** Superseded-commit rows are never read again but nothing deletes them yet; a retention sweep can be added later if row count becomes a real problem.

## Design decisions

- **Cache key is the exact commit sha, not the repo alone.** A map keyed only by `repoFullName` would silently go stale the moment the default branch moves — serving an agent a description of files that may have been renamed or removed since. Keying on the sha the agent is actually about to work against makes the cache self-invalidating with no push notification needed: a new commit is automatically a cache miss.
  - Known tradeoff: this keys on the *exact* HEAD being cloned, not the branch's merge-base with its default branch. A later session against the same actively-committed `agent/<session-id>` branch will miss cache even though the surrounding repo structure hasn't meaningfully changed. Accepted for now — clone happens once per session, not once per turn, so this doesn't bite within a session, only across separate sessions on the same evolving branch. Not worth the added complexity of computing a merge-base today.
- **Injection point, not a tool.** The map is dead text baked into the system prompt before the SDK query starts — the agent has no awareness a "map" or a cache exists, exactly like `team.shared_context` today. No new agent-facing tool, no prompting work to teach the agent to use it.
- **Generation is a one-shot Agent SDK exploration, not static analysis.** A plain directory/manifest scan is free but shallow — it can't explain conventions or non-obvious structure the way this repo's own `CLAUDE.md` does. A fixed-prompt agent turn (same rubric: structure, key modules, build/test commands, conventions) produces the kind of map that actually saves the *next* agent's exploration, at the cost of one extra turn on cache miss only.
- **Generation always uses a fixed cheap model (Haiku), independent of the agent's configured model.** The map's job is orientation, not judgment — no reason to pay the task's model price for it, and it bounds generation cost regardless of what model an org configures its agents with.
- **Generation cost is tracked but not billed to the triggering run.** `repo_maps.generationCostUsd`/`generationTokens` record what generation cost for observability, but this is amortized infrastructure cost across every future run against that commit — not attributable to whichever run happened to trigger it first. It never touches `runs.cost_usd` or a run's budget.
- **Failure is always non-blocking.** Generation failing, timing out, or a sandbox exec error all fall back to "no map" — the run proceeds exactly as it does today without this feature. This applies identically to the run-time path and the pre-warm path.
- **Pre-warming needs a queue because it needs a sandbox, and only the worker can create one.** Same reasoning as the existing `SANDBOX_TEARDOWN_QUEUE_NAME`: `apps/web` can't talk to Docker directly.
- **Pre-warming is best-effort, never authoritative.** The run-time `ensureRepoMap` call is the real fallback path regardless of whether warming ran, succeeded, or was ever triggered. A failed or skipped warm job simply means the first real run against that commit pays the generation cost, which is exactly the pre-feature behavior.
- **A pre-warm job's sandbox is always torn down, including on error.** The warm sandbox is a throwaway created solely for this job (unlike a session's long-lived warm container), so its lifecycle is a strict try/finally: any failure after `sandboxProvider.create` succeeds — clone failure, generation failure, an unexpected throw — still reaches `sandboxProvider.destroy` in a `finally` block. The destroy call itself is best-effort (logged, not rethrown) so a teardown-side error can't mask the original failure. This is scoped to the warm path only — the run-time `ensureRepoMap` call operates on a session's existing long-lived sandbox and must never destroy it on a map-generation failure.
- **Warm-job retries are acceptable where run retries are not.** ARCHITECTURE.md §4's "no automatic retries" rule exists because a run may have already pushed a commit or commented on a PR — retrying duplicates side effects. A warm job never touches the target repo's remote (read-only clone, no commits, no PR), so BullMQ's default retry/backoff is safe to leave on for transient failures (network blip, GitHub API hiccup).
- **Cache existence is checked before provisioning a sandbox.** The warm job resolves the default branch's HEAD sha via the GitHub API first (no sandbox), and only provisions one on an actual cache miss — avoiding needless container churn when warming a repo that's already mapped.

## Mechanism

### Schema

```ts
export const repoMaps = pgTable(
  "repo_maps",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(), // "org/repo", matches CloneTarget.repoFullName
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

Plain `text`, not S3/content-addressed — follows `teams.shared_context`'s reasoning (small, hot, read on every run) rather than the skills-bundle pattern, which exists for multi-file content. No foreign key to `connections`; `repoFullName` alone is the cache key, resolved to an installation at clone time exactly like `scm-provider.ts` already does.

```ts
// teams table addition
defaultCodebase: text("default_codebase"),
```

### Run-time path: `ensureRepoMap`

Inserted into the pipeline right after clone:

```
resolveCredentials → composeContext → provisionSandbox → cloneRepo → ensureRepoMap → executeRun → finalizeArtifacts → teardown
```

```ts
async function ensureRepoMap(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  orgId: number,
  repoFullName: string,
): Promise<string> {
  const sha = await gitRevParseHead(sandboxProvider, sandboxId); // repo already cloned here
  const cached = await getRepoMap(orgId, repoFullName, sha);
  if (cached) return cached.content;

  const generated = await generateRepoMap(sandboxProvider, sandboxId).catch((err) => {
    console.error(`Repo map generation failed for ${repoFullName}@${sha}:`, err);
    return undefined;
  });
  if (!generated) return "";

  const content = generated.text.slice(0, 16384);
  await insertRepoMap({ orgId, repoFullName, commitSha: sha, content, ...generated.usage })
    .catch(() => undefined); // ON CONFLICT DO NOTHING race — a concurrent insert already won
  return content;
}
```

`worker.ts:138` becomes:

```ts
const repoMap = workspace ? await ensureRepoMap(sandboxProvider, sandboxId, orgId, workspace.repoFullName) : "";
const systemPrompt = composeSystemPrompt(teamContextPrefix, repoMap, agent.systemPrompt);
```

`composeSystemPrompt` in `prompt-composition.ts` takes the new middle argument and concatenates it between `teamContextPrefix` and `agentSystemPrompt`, per ARCHITECTURE.md §3's ordering (shared context before agent-specific prompt). An empty repo map contributes nothing to the string.

### `generateRepoMap` — the one-shot exploration turn

A second, independent Claude Agent SDK `query()` call in the same sandbox (which already has the repo checked out at `/workspace` from the clone step) — not `run-turn.ts`'s user-facing call, a separate fixed-prompt call:

- **Model**: hardcoded cheap tier (Haiku), regardless of the agent's assigned model.
- **Prompt** (fixed, not user-editable): explore the repo and produce a concise map — directory structure and what each area is for, key entry points, build/test/lint commands, non-obvious conventions. Explicit word budget in the prompt, enforced again by truncation on the way into the DB.
- **Tools**: same full toolset already available in the sandbox — it explores the way the real agent would, once, and the result is cached.
- **Timeout**: its own short wall-clock cap (e.g. 2 minutes), independent of the triggering run's budget — a hung generation shouldn't stall or fail the user's actual task.

### Pre-warm path: `warmRepoMap`

```ts
async function warmRepoMap(orgId: number, repoFullName: string): Promise<void> {
  const sha = await resolveDefaultBranchSha(orgId, repoFullName); // GitHub API, no sandbox
  if (await getRepoMap(orgId, repoFullName, sha)) return;         // cache hit, nothing to do

  const sandboxId = await sandboxProvider.create(warmSandboxSpec);
  try {
    await cloneIntoSandbox(sandboxProvider, sandboxId, /* target at sha */);
    await ensureRepoMap(sandboxProvider, sandboxId, orgId, repoFullName);
  } finally {
    await sandboxProvider.destroy(sandboxId).catch((err) => {
      console.error(`Failed to tear down warm sandbox ${sandboxId} for ${repoFullName}:`, err);
    });
  }
}
```

### Queue plumbing

```ts
// packages/queue/src/index.ts
export const REPO_MAP_WARM_QUEUE_NAME = "repo-map-warm";
export interface RepoMapWarmJobData { orgId: number; repoFullName: string }

const repoMapWarmQueue = new Queue<RepoMapWarmJobData>(REPO_MAP_WARM_QUEUE_NAME, { connection: queueConnection });

export async function enqueueRepoMapWarmJob(orgId: number, repoFullName: string): Promise<void> {
  await repoMapWarmQueue.add("warm-repo-map", { orgId, repoFullName }, { jobId: `${orgId}:${repoFullName}` });
}
```

The fixed `jobId` collapses duplicate warm requests for the same repo (e.g. an agent's and a team's `defaultCodebase` both naming it) into one job. The worker registers a processor for this queue alongside its existing `runs` and `sandbox-teardown` processors, calling `warmRepoMap` with the job's data.

### Trigger points in `apps/web`

- Agent create/update route: when the request sets `defaultCodebase` to a new non-empty value, call `enqueueRepoMapWarmJob(orgId, defaultCodebase)` after the DB write succeeds. Fire-and-forget — the response doesn't await it.
- Team create/update route: identical, reading the new `defaultCodebase` field. UI: a repo selector on the team create/edit form, mirroring the existing agent `defaultCodebase` selector (`tasks/new/page.tsx`'s pattern) — a dropdown of the org's connected repos, not free text.

## Testing

- `ensureRepoMap`: cache hit skips the SDK entirely; cache miss generates and inserts; generation failure/timeout returns `""` without throwing; oversized content is truncated before insert.
- `composeSystemPrompt`: repo map slots into the correct position; empty repo map produces the same output as today (no regression for repos with no map yet).
- `warmRepoMap`: cache-hit-via-API-sha never calls `sandboxProvider.create`; cache miss provisions → generates → tears down; a thrown error after sandbox creation (clone failure, generation failure) still reaches `sandboxProvider.destroy` — assert `destroy` was called even when the surrounding function rejects; a `destroy` failure is logged, not thrown, and doesn't mask the original error.
- `repo_maps` schema: concurrent insert for the same `(orgId, repoFullName, commitSha)` — second insert no-ops via `ON CONFLICT DO NOTHING`, only one row survives.
- Manual verification gate (no e2e harness for the sandbox pipeline yet): set an agent's `defaultCodebase` to a real connected repo, confirm a `repo_maps` row appears without starting a run; start a run against that repo, delete the row, confirm `runs.prompt_hash` changes on the next run (proves the map is actually composed into the prompt, not inert).
