# Jira Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Note that `subagent-driven-development` dispatches one implementer at a time by design ("never dispatch multiple implementation subagents in parallel"); for the concurrent waves below, either dispatch each wave's tasks together per `superpowers:dispatching-parallel-agents`, or run one `executing-plans`/worktree session per lane and merge — see "Parallel execution" below.

**Goal:** Let an org connect a Jira Cloud site, create an AgentFactory task from a Jira issue by pasting its key or URL (pulling in its attachments so the agent is aware of them), have the linked Jira issue receive a comment (and optionally a status transition) when a run opens the pull request, and keep that task checked against Jira via a manual refresh and an automatic pre-run staleness check.

**Architecture:** A new `connection_secrets` table plus `connections.auth`/`credential_ref` gives the platform its first encrypted credential store (AES-256-GCM under `CONNECTION_SECRET_KEY`), built exactly as `ARCHITECTURE.md:205` specifies. A new `packages/integrations` workspace package holds a `TaskProvider` port and its first adapter `JiraTaskProvider`, reached through a `createTaskProvider()` factory modelled on `createBlobStore()`; no Jira-shaped type leaves that package. `apps/web` gains a connect/verify route and a Connections UI action; `apps/worker` gains a single write-back call at the existing one-shot PR-open hook point in `worker.ts`. Attachments ride the already-built but unwired `task_context_items` + `content_blobs` pipeline (`apps/web/src/app/api/tasks/[taskId]/context-items/route.ts` is the template) rather than a new store, and the pre-run staleness check is one extra branch in the existing `POST /api/tasks/[taskId]/run` route, not a new execution path. Nothing in the sandbox, the prompt-composition *pipeline's mechanism*, or the `AgentRuntime` path changes — `materialiseTaskDocuments` (`apps/worker/src/task-documents.ts`) gets one small, additive change (Task 7) so it also names unindexed Jira attachments in the "not available in your checkout" line it already emits.

**Tech Stack:** TypeScript, pnpm workspace, Next.js 16 App Router, Drizzle ORM / Postgres, `node:crypto`, Vitest (`pnpm test:unit`, `pnpm test:db`), Playwright (`pnpm test:e2e`).

**Spec:** `docs/superpowers/specs/2026-09-12-jira-integration-design.md` — read it before starting any task; this plan implements it task-by-task and does not repeat its rationale.

> **Blocked on sign-off.** The spec closes with four product questions (API-token-before-OAuth, no issue creation / no continuous sync, transition-on-PR-open, Cloud-only). Task 1 must not start until those are answered — a "no" to any of them changes the schema or the scope, not just the code.

## Global Constraints

- **No Jira-shaped type may appear in `packages/core`, `packages/db`, or any API route payload.** `fields.summary`, ADF nodes, transition payloads, and Atlassian error bodies are translated inside `packages/integrations/src/jira/` and never escape it. This is the `AgentRuntime`/`ScmProvider` rule from `ARCHITECTURE.md` applied to the `tasks` kind, and it is the single constraint most likely to be violated by accident.
- **No credential is ever returned by an API route, logged, or written into `connections.config`.** `GET /api/connections` already returns `config` verbatim to the browser (`apps/web/src/app/api/connections/route.ts:5-9`), so `config` is a public field by construction. Secrets live only in `connection_secrets.ciphertext`.
- **No credential reaches the sandbox.** Every Jira HTTP call runs in the Next.js server process or the worker host process. Do not add a Jira env var to the sandbox spec, and do not pass a site URL or token through `runAgentTurn`. See `apps/worker/src/scm-provider.ts:218-276` for the standing reasoning.
- **Write-back never fails a run.** Every call in Task 6 is wrapped so a provider error emits a `RunEvent` and returns; the run still reports `pr_open`. Mirror `skills-materialize.ts`, which returns `[]` and logs rather than throwing.
- **The staleness check never blocks a run.** `checkTaskSync` (Task 7) fails open: any provider error, timeout, or missing connection means "not stale," never "run refused." Only a successful fetch that shows the issue genuinely changed is allowed to stop a run from starting.
- **A write-back failure is never left only on the run transcript.** Task 6's catch block sets `TaskExternalRef.writeBackFailure` alongside the `RunEvent`, so the tasks list and task detail page can show it without anyone having to open that run. A successful write-back must leave `writeBackFailure` unset.
- **At most one `kind: "tasks"` connection per org.** Task 4's connect route checks for an existing one and returns `409` before calling `verify()`. This is what makes `resolveTaskProvider`'s "first tasks connection" correct rather than merely convenient — see Design decision 15.
- Every new repository function and API route is org-scoped. Note that the existing `deleteConnection(id)` is **not** org-scoped — any new call site must pre-check with `getConnection(orgId, id)`, as `apps/web/src/app/api/connections/[connectionId]/route.ts` already does.
- All user-facing strings are added to `apps/web/src/lib/i18n/dictionaries/en.ts` first. Be deliberate: `connections.provider.${provider}` lookups use the `(string & {})` escape hatch in `paths.ts:11`, so a missing key fails silently at runtime rather than at compile time.
- No em dashes in user-facing strings this plan adds.
- Run `pnpm typecheck` and the relevant suite before every commit in every task. **Tests are run from the repo root, not per package** — `vitest.config.ts` defines three projects that glob across the whole workspace, and packages like `packages/storage` have no `test` script at all. Placement decides which project picks a file up: anything at `**/src/**/__tests__/**/*.test.ts` runs under `pnpm test:unit`, except `packages/db/src/__tests__/repositories/**`, which is excluded from `unit` and runs under `pnpm test:db` against a real database with `fileParallelism: false`. Put a test in the wrong directory and it either never runs or tries to reach Postgres from the unit suite.

## Parallel execution

Every task below states a **Depends on** line with its true minimal dependency — an interface it
consumes or a file it builds on — not just "the previous task," and it is the authority on ordering.
Two tasks with no dependency edge between them, in either direction, and no overlapping file in
their **Files** lists are safe to dispatch to separate subagents at the same time. Two tasks that
both depend on nothing further from each other but *do* share a file are not safe to run
concurrently as-is; where that happens below, the shared file has been restructured (see the `en.ts`
note) so the two tasks touch disjoint regions of it instead.

**Dependency graph** (derived from each task's Interfaces/Files, not narrative order):

```
Task 1 (schema, core types)  ─┬─> Task 2 (credential encryption)  ─┐
Task 3 (TaskProvider + Jira)  ─┴──────────────────────────────────┼─> Task 4 (connect Jira)
                                                                    │        │
                                                       ┌────────────┴───┐    │
                                                       ▼                ▼    │
                                              Task 5 (task ← issue)  Task 6 (write-back)
                                                       │
                                                       ▼
                                              Task 7 (refresh + staleness)
```

Task 3 has no dependency on Task 1 or Task 2 — it is a standalone workspace package that only
consumes the pre-existing `Connection`/`ConnectionProvider` shapes, neither of which Task 1 changes
in a way Task 3's code reads. Task 6 does not depend on Task 5: write-back only needs `Task
.externalRef` (Task 1's type) and `resolveTaskProvider`'s pattern (Task 4's file) — nothing it
touches was created by Task 5, and the "Depends on Tasks 1-5" a narrative reading might suggest
would be overstating it. Task 7 genuinely needs Task 5, because its Refresh button is placed next
to the linked-issue badge Task 5 renders, and its "apply" path reuses Task 5's persist-and-ingest sequence.

**Resulting waves**, if dispatching batches of subagents and waiting for each batch before the next
(a finer-grained scheduler could start Task 2 the moment Task 1 lands without waiting on Task 3, but
waves are the simple, safe reading):

| Wave | Tasks | Why they're safe together |
|---|---|---|
| 1 | Task 1 ∥ Task 3 | No dependency edge either direction; zero files in common (`packages/db`+`packages/core` vs. a fresh `packages/integrations`) |
| 2 | Task 2 | Needs Task 1's `connection_secrets` table; nothing else is unblocked yet |
| 3 | Task 4 | Needs Tasks 1, 2, and 3 — the join point; nothing parallelizes with the one task everything downstream depends on |
| 4 | Task 5 ∥ Task 6 | Both depend only on Task 4, not on each other. Files: Task 5 touches task-creation/detail UI, `api/tasks/*`, `task-context-items.ts`; Task 6 touches `apps/worker/*`, `ConnectionsList.tsx`, `api/connections/jira/route.ts`. Two files are touched by both — `en.ts` and the task detail page — see below for how each is kept conflict-safe |
| 5 | Task 7 | Needs Task 5's task-detail UI in place |

**The unavoidable shared files.** Two files end up touched by both of Wave 4's tasks:

- **`en.ts`.** Tasks 4, 5, 6, and 7 all add user-facing strings to the single
  `apps/web/src/lib/i18n/dictionaries/en.ts` dictionary (Global Constraints: all strings go there
  first). Left as "add your keys to `en.ts`," Wave 4's two parallel tasks would both be editing near
  the same nested object and produce a real merge conflict. Task 1, Step 7 below pre-creates one
  empty, uniquely-named object per downstream task — `connections.jira`, `connections.jiraWriteBack`,
  `taskCreate.linkedIssue`, `taskDetail.linkedIssue`, `taskDetail.sync`, and a top-level `writeBackFailure` —
  so Tasks 4-7 each only ever fill in keys inside an object nobody else touches. `writeBackFailure`
  is deliberately *not* nested under `taskDetail` alongside Task 5's `linkedIssue` key, even though
  both are task-detail-page strings — Task 5 and Task 6 share a wave, so a shared parent object
  between them would recreate the exact conflict this step exists to avoid.
- **The task detail page.** Task 5 adds the linked-issue badge and attachment list; Task 6 (see its own
  section) adds a one-line mount of a self-contained `WriteBackFailureBanner` component. Both edits
  are small, additive, and land in different parts of the page's JSX — low collision risk even
  without a structural fix — but unlike `en.ts` there is no pre-stub for a page's render tree, so if
  Tasks 5 and 6 run as genuinely separate worktree branches, whichever lands second needs a trivial
  rebase over the first's one-line addition before merging. This is the one place in Wave 4 that
  isn't fully conflict-free by construction, only low-conflict by construction.

This is the only change this parallelization pass makes to Task 1; everything else below is
annotation, not new work.

---

### Task 1: Schema, core types, and the missing connection writers

**Depends on:** nothing — foundational. **Parallelizable with:** Task 3 (see "Parallel execution" above; no dependency edge, no shared files).

**Files:**
- Modify: `packages/db/src/schema.ts` — add `connectionAuthKindEnum`, the `connection_secrets` table, `connections.auth`, `connections.credentialRef`, `tasks.externalRef`.
- Modify: `packages/core/src/domain.ts` — add `ConnectionAuthKind` and `TaskExternalRef`; add `auth` to `Connection` and `externalRef` to `Task`.
- Modify: `packages/db/src/repositories/connections.ts` — add `updateConnection` and `setConnectionHealth`; carry `auth` through `toConnection` and `NewConnectionInput`.
- Modify: `packages/db/src/repositories/tasks.ts` — carry `externalRef` through the row mapper and the update input.
- Create: `packages/db/drizzle/*.sql` (generated, not hand-written).
- Test: `packages/db/src/__tests__/repositories/connections.test.ts`, `packages/db/src/__tests__/repositories/tasks.test.ts`.

**Interfaces:**
- Produces (used by every later task): the `connectionSecrets` Drizzle table; `ConnectionAuthKind = "none" | "api_token" | "oauth2"`; `TaskExternalRef { provider: ConnectionProvider; key: string; url: string }`; `Connection.auth`; `Task.externalRef?`; `updateConnection(orgId, id, patch)`; `setConnectionHealth(orgId, id, health)`.

- [ ] **Step 1: Add the schema**

In `packages/db/src/schema.ts`, add beside the existing `connectionKindEnum`/`connectionHealthEnum` (around line 140) and after the `connections` table:

```ts
// Mirrors ConnectionAuthKind in packages/core/src/domain.ts. "none" is the GitHub case: the
// platform App mints a scoped, hour-lived installation token on demand, so there is nothing to
// store. Every other provider has to persist something, which is what connection_secrets is for.
export const connectionAuthKindEnum = pgEnum("connection_auth_kind", ["none", "api_token", "oauth2"]);

// The vault ARCHITECTURE.md §2.7 calls for: "Credential lives in the vault; only a reference
// here." Deliberately a separate table rather than a column on `connections` — GET
// /api/connections returns connections.config verbatim to the browser, so anything on that row
// is one careless spread away from being public.
export const connectionSecrets = pgTable("connection_secrets", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  // AES-256-GCM: base64(iv[12] || authTag[16] || payload). keyVersion lets a future key rotation
  // be a re-encrypt migration rather than a schema change.
  ciphertext: text("ciphertext").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Add to the `connections` table body:

```ts
  auth: connectionAuthKindEnum("auth").notNull().default("none"),
  // Nullable, and "none" is the default, so every existing GitHub row is already correct with no
  // backfill. set null (not cascade) on secret deletion: losing the credential must degrade the
  // connection to unhealthy, not silently delete the user's configuration.
  credentialRef: integer("credential_ref").references(() => connectionSecrets.id, { onDelete: "set null" }),
```

Add to the `tasks` table body, beside `prNumber`/`prUrl`:

```ts
  // The upstream issue this task mirrors, e.g. { provider: "jira", key: "PROJ-123", url: ... }.
  // Generic rather than a jira_issue_key column so Monday/Asana need no migration.
  externalRef: jsonb("external_ref").$type<TaskExternalRef>(),
```

`connectionSecrets` must be defined *before* `connections` references it, or use the `() => table` callback form already used throughout the file.

- [ ] **Step 2: Generate and inspect the migration**

Run: `pnpm --filter @agentfactory/db db:generate`
Expected: a new file under `packages/db/drizzle/` containing `CREATE TYPE "connection_auth_kind"`, `CREATE TABLE "connection_secrets"`, `ALTER TABLE "connections" ADD COLUMN "auth"`, `ALTER TABLE "connections" ADD COLUMN "credential_ref"`, and `ALTER TABLE "tasks" ADD COLUMN "external_ref"`. Open it and confirm the `auth` column has `DEFAULT 'none' NOT NULL` — without the default, the migration fails against a non-empty `connections` table.

- [ ] **Step 3: Update core types**

In `packages/core/src/domain.ts`, after `ConnectionHealth` (line 148):

```ts
export type ConnectionAuthKind = "none" | "api_token" | "oauth2";
```

Add `auth: ConnectionAuthKind;` to `Connection`. Do **not** add `credentialRef` — `Connection` is what `/api/connections` serialises, and the reference is a persistence detail.

Beside `Task` (line 225), add:

```ts
/** A task's link to the upstream issue it mirrors. AgentFactory remains the system of record. */
export interface TaskExternalRef {
  provider: ConnectionProvider;
  /** Provider-native identifier, e.g. a Jira issue key "PROJ-123". */
  key: string;
  /** Browse URL, stored so the UI can link out without reconstructing it per provider. */
  url: string;
  /** The provider's own last-modified timestamp as of the last fetch. Drives Task 7's staleness check. */
  lastKnownUpdated: string;
}
```

and `externalRef?: TaskExternalRef;` to `Task`.

- [ ] **Step 4: Add the missing connection writers**

`packages/db/src/repositories/connections.ts` today is `list`/`get`/`create`/`delete` only, which is why `connections.health` is permanently `"healthy"`. Add, org-scoped (unlike the existing `deleteConnection`):

```ts
export interface ConnectionPatch {
  label?: string;
  config?: Record<string, unknown>;
  health?: ConnectionHealth;
  credentialRef?: number | null;
}

export async function updateConnection(orgId: number, id: number, patch: ConnectionPatch): Promise<Connection | undefined>;

/** Called from the credential paths: 401 -> "expired", any other provider failure -> "needs-attention". */
export async function setConnectionHealth(orgId: number, id: number, health: ConnectionHealth): Promise<void>;
```

Carry `auth` through `toConnection` and add `auth`/`credentialRef` to `NewConnectionInput` (both optional; `auth` defaults to `"none"`).

- [ ] **Step 5: Carry `externalRef` through the tasks repository**

Add `externalRef: row.externalRef ?? undefined` to the tasks row mapper and accept `externalRef` in both the create input and the update patch. Confirm no existing caller breaks — `updateTask` is called from `apps/worker/src/worker.ts:418` and `:469`.

- [ ] **Step 6: Extend the repository tests**

Add to `connections.test.ts`: `auth` defaults to `"none"` on create; `updateConnection` is org-scoped (an update with the wrong `orgId` returns `undefined` and mutates nothing); `setConnectionHealth` round-trips each of the three values. Add to `tasks.test.ts`: `externalRef` round-trips and is `undefined` when unset.

- [ ] **Step 7: Pre-create the i18n namespaces Tasks 4-7 will fill in**

This step exists only for "Parallel execution" above — it has nothing to do with schema or types,
but Task 1 is the one task every later task depends on, so it is the only safe place to stake out
shared ground before Wave 4 dispatches two tasks that both touch `en.ts` at once. In
`apps/web/src/lib/i18n/dictionaries/en.ts`, add six empty objects, each owned by exactly one later
task and never touched by any other:

```ts
// Owned by Task 4. Owned by Task 6. Owned by Task 5. Owned by Task 5. Owned by Task 7.
// `connections.jira` stays Jira-named on purpose (the connect form is inherently
// provider-specific — see the spec's Design decision 14); `taskCreate`/`taskDetail`'s keys are
// named for what they're for (linking an issue, syncing it), not for Jira, because the code
// behind them is already provider-neutral and will stay that way when a second adapter lands.
connections: {
  // ...existing keys...
  jira: {},              // Task 4 — connect-a-Jira-site modal strings
  jiraWriteBack: {},      // Task 6 — write-back config panel strings
},
taskCreate: {
  linkedIssue: {},        // Task 5 — "From issue" field: disabled tooltip, dynamic label, fetch UI
},
taskDetail: {
  linkedIssue: {},        // Task 5 — badge + attachment list strings
  sync: {},                // Task 7 — Refresh button + stale-dialog strings
},
// Deliberately its own top-level key, not nested under taskDetail — Task 5 also owns a key
// directly inside taskDetail, and the two are dispatched in the same wave (4). A shared parent
// object with two owners in one wave is exactly the conflict this step exists to avoid; a
// sibling top-level key with a single owner is not.
writeBackFailure: {},  // Task 6 — tasks-list tooltip + task-detail banner strings
```

(`connections` already exists in `en.ts` — add `jira`/`jiraWriteBack` alongside its current keys.
`taskCreate`/`taskDetail`/`writeBackFailure` are new top-level sections if they don't already
exist.) Each of Tasks 4-7 fills in exactly one of these six objects and none of the others — two
tasks in the same wave never add a sibling key to an object the other also writes to, so their diffs land on disjoint
lines. `TranslationKey` (`paths.ts`) is derived from `typeof en`, so these stubs are real, typed
keys the moment this commits — a later task filling one in is a normal edit, not a first-touch.

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm test:db`
Expected: no errors; all existing connection and task repository tests still pass. `pnpm test:db` needs Postgres up (`docker compose up -d`).

```bash
git add packages/db/src/schema.ts packages/db/drizzle packages/core/src/domain.ts \
  packages/db/src/repositories/connections.ts packages/db/src/repositories/tasks.ts \
  packages/db/src/__tests__/repositories/connections.test.ts packages/db/src/__tests__/repositories/tasks.test.ts \
  apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(db): add connection_secrets, connection auth kind, and task external refs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Credential encryption and the connection-secrets repository

**Depends on Task 1** (the `connection_secrets` table this task's repository reads and writes). **Not** dependent on Task 3 — may run alongside it if Task 3 is still in progress when Task 1 finishes.

**Files:**
- Create: `packages/db/src/crypto.ts` — `encryptSecret` / `decryptSecret`.
- Create: `packages/db/src/repositories/connection-secrets.ts`.
- Modify: `packages/db/src/index.ts` — export both.
- Modify: `README.md` — document `CONNECTION_SECRET_KEY` beside the existing GitHub App env vars.
- Test: `packages/db/src/__tests__/crypto.test.ts`, `packages/db/src/__tests__/repositories/connection-secrets.test.ts`.

**Interfaces:**
- Produces (used by Tasks 4, 5, 6): `createConnectionSecret(orgId, plaintext: Record<string, string>): Promise<number>`; `readConnectionSecret(orgId, id): Promise<Record<string, string> | undefined>`; `deleteConnectionSecret(orgId, id): Promise<void>`. Callers pass and receive a plain object; encryption is entirely internal.

- [ ] **Step 1: Write the failing crypto test**

`packages/db/src/__tests__/crypto.test.ts` — note the path: directly under `__tests__/`, **not** under `__tests__/repositories/`, so it runs in the fast `unit` project with no database. Covering: a round trip returns the original object; two encryptions of identical plaintext produce different ciphertexts (random IV); flipping one base64 character makes `decryptSecret` throw (GCM auth tag); a missing `CONNECTION_SECRET_KEY` throws a message naming the variable; a key that is not 32 bytes after base64-decoding throws a message saying so rather than a generic `node:crypto` error.

- [ ] **Step 2: Implement `crypto.ts`**

AES-256-GCM. Read the key **inside** the function, never at module scope — the same rule `packages/storage/src/index.ts:14-30` documents for `createBlobStore()`, so that importing the module in a context without the env var does not throw at import time. Envelope is `base64(iv[12] || authTag[16] || ciphertext)`. Export `CURRENT_KEY_VERSION = 1` so the repository can stamp `keyVersion` without duplicating the constant.

- [ ] **Step 3: Implement the repository**

`createConnectionSecret` JSON-stringifies, encrypts, inserts, returns the new id. `readConnectionSecret` selects by `(orgId, id)` — org-scoped, unlike `deleteConnection` — decrypts, and returns `undefined` for a missing row (but *throws* on a decryption failure, which means key mismatch or tampering and must not be silently swallowed). `deleteConnectionSecret` is org-scoped.

- [ ] **Step 4: Write the repository integration test**

`packages/db/src/__tests__/repositories/connection-secrets.test.ts` — under `repositories/`, so it runs in the `db-integration` project against a real database. Round trip through the real database; org isolation (org B cannot read org A's secret by id); cascade delete when the parent org is deleted; and — the one that matters — after `deleteConnectionSecret`, the referencing `connections` row still exists with `credential_ref` set to `NULL`, confirming the `set null` FK from Task 1.

- [ ] **Step 5: Document the env var**

In `README.md`, beside `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, add `CONNECTION_SECRET_KEY` for both `apps/web/.env.local` and `apps/worker/.env.local`, with the generation command (`openssl rand -base64 32`) and an explicit warning that rotating it orphans every stored credential until users reconnect.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm test:unit && pnpm test:db`

```bash
git add packages/db/src/crypto.ts packages/db/src/repositories/connection-secrets.ts \
  packages/db/src/index.ts packages/db/src/__tests__/crypto.test.ts \
  packages/db/src/__tests__/repositories/connection-secrets.test.ts README.md
git commit -m "feat(db): encrypt connection credentials at rest

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `packages/integrations` — the `TaskProvider` port and `JiraTaskProvider`

**Depends on:** nothing — foundational, like Task 1. **Parallelizable with:** Task 1 (see "Parallel execution" above). This package only consumes the pre-existing `Connection`/`ConnectionProvider` shapes from `@agentfactory/core`; it does not read the `auth` field Task 1 adds, so it never needs to wait on Task 1's migration or types to land.

**Files:**
- Create: `packages/integrations/package.json`, `tsconfig.json`, `src/index.ts`.
- Create: `packages/integrations/src/task-provider.ts` — the port, `ProviderError`, `createTaskProvider`.
- Create: `packages/integrations/src/jira/jira-task-provider.ts`, `src/jira/adf.ts`, `src/jira/parse-ref.ts`.
- Create: `packages/integrations/src/jira/__tests__/fixtures/*.json` — recorded Jira responses.
- Test: `packages/integrations/src/jira/__tests__/{jira-task-provider,adf,parse-ref}.test.ts`.

No change to `pnpm-workspace.yaml` — it already globs `packages/*`.

**Interfaces:**
- Produces (used by Tasks 4, 5, 6): `TaskProvider`, `ExternalIssue`, `IssueTransition`, `ProviderError`, and `createTaskProvider(connection: Connection, secret: Record<string, string>): TaskProvider`.
- Consumes: `Connection` and `ConnectionProvider` from `@agentfactory/core` (types only — this package must not depend on `@agentfactory/db`, or the worker's dependency graph gains a cycle).

- [ ] **Step 1: Scaffold the package**

Copy `packages/storage/package.json` and `tsconfig.json` as the template. Name it `@agentfactory/integrations`, `"private": true`, `"type": "module"`, `main`/`types` both `./src/index.ts`. Dependencies: `@agentfactory/core` (`workspace:*`) only. Scripts: `typecheck` only — **do not add a `test` script**; `packages/storage` has none either, because the root `vitest.config.ts` globs test files across the workspace. `pnpm-workspace.yaml` already globs `packages/*`, so no change there.

Run: `pnpm install && pnpm typecheck`
Expected: the new package resolves and type-checks.

- [ ] **Step 2: Write `parse-ref.ts` and its test, test first**

Cases the test must cover: a bare key (`PROJ-123`); a key embedded in a sentence; a browse URL (`https://acme.atlassian.net/browse/PROJ-123`); a browse URL with a query string or trailing slash; a URL for a *different* site than the connection's (must be rejected, not silently fetched — otherwise org A can read org B's Jira through a pasted link); lowercase input; text containing no reference (returns `undefined`); and a false positive guard such as `UTF-8` or `COVID-19`, which match a naive `[A-Z]+-\d+` regex. This mirrors `scm-provider.parseIssueReference` (`apps/worker/src/scm-provider.ts:107-124`), which is the only other place in the codebase that parses an issue reference out of free text.

- [ ] **Step 3: Write `adf.ts` and its test, test first**

Atlassian Document Format → Markdown for the node types that actually appear in issue descriptions: `paragraph`, `text` with `strong`/`em`/`code` marks, `bulletList`/`orderedList`/`listItem`, `codeBlock`, `heading`, `link` marks, `hardBreak`, `rule`. **Unknown node types must degrade to their concatenated text content, never throw and never emit partial markup** — Jira descriptions contain panels, macros, tables, and media that we are not going to model, and a task prefill that is slightly lossy is fine while one that throws is not. Include a fixture with a `mediaSingle` node to pin that behaviour.

- [ ] **Step 4: Write the port**

```ts
// packages/integrations/src/task-provider.ts
export interface ExternalAttachment {
  filename: string; mime: string; sizeBytes: number;
  /** Authenticated provider URL, opaque to the caller — passed straight back into fetchAttachment. */
  contentUrl: string;
}

export interface ExternalIssue {
  key: string; title: string; description: string;
  status: string; issueType: string; labels: string[]; url: string;
  attachments: ExternalAttachment[];
  /** Provider's own last-modified timestamp. What Task 7's staleness check compares. */
  updated: string;
}
export interface IssueTransition { id: string; name: string; toStatus: string }

export class ProviderError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
  /** 401/403 means the credential is dead; anything else is transient or scope-specific. */
  get isAuthFailure(): boolean { return this.status === 401 || this.status === 403; }
}

export interface TaskProvider {
  verify(): Promise<{ accountId: string; displayName: string }>;
  parseIssueReference(text: string): string | undefined;
  fetchIssue(key: string): Promise<ExternalIssue | undefined>;
  fetchAttachment(attachment: ExternalAttachment): Promise<Uint8Array>;
  listTransitions(key: string): Promise<IssueTransition[]>;
  addComment(key: string, body: string): Promise<void>;
  transitionIssue(key: string, transitionId: string): Promise<void>;
}

export function createTaskProvider(connection: Connection, secret: Record<string, string>): TaskProvider;
```

`createTaskProvider` switches on `connection.provider` and throws a clear error for a provider it does not implement — the same shape as `createBlobStore()` (`packages/storage/src/index.ts:14-30`).

- [ ] **Step 5: Write `JiraTaskProvider` and its test, test first**

Record fixtures for `GET /rest/api/3/myself`, `GET /rest/api/3/issue/{key}`, `GET /rest/api/3/issue/{key}/transitions`, and the error bodies for 401, 404, and 429. The test stubs `globalThis.fetch` and asserts: the `Authorization` header is `Basic base64(email:token)`; `fetchIssue` maps `fields.summary` → `title`, ADF `fields.description` → Markdown, `fields.status.name` → `status`, `fields.issuetype.name` → `issueType`, `fields.labels` → `labels`, `fields.updated` → `updated`, `fields.attachment[]` → `attachments` (`filename`/`mimeType`/`size`/`content` mapped to `ExternalAttachment`'s shape), and builds `url` from the connection's `siteUrl`; a 404 returns `undefined` rather than throwing (an issue that does not exist is a normal user outcome); a 401 throws `ProviderError` with `isAuthFailure === true`; a 429 is retried once after honouring `Retry-After` (bounded — one retry, capped delay) and then throws. `fetchAttachment` sends the same `Authorization` header as `fetchIssue` against the attachment's `contentUrl` (Jira's attachment content endpoint requires auth same as everything else) and returns the raw body as `Uint8Array`.

`addComment` posts an ADF document, not a Markdown string — Jira Cloud REST v3 rejects a plain-string comment body. Build the minimal `{ type: "doc", version: 1, content: [...] }` envelope inside the adapter and cover it with a test, because this is the single most likely thing to be wrong on first run against a real site.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm test:unit`
Expected: all three new test files are picked up by the `unit` project and pass with no network access (every `fetch` stubbed).

```bash
git add packages/integrations
git commit -m "feat(integrations): add TaskProvider port and Jira adapter

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Connect a Jira site — API and Connections UI

**Depends on Tasks 1–3** (`Connection.auth`/`updateConnection`, the secrets repository, and `TaskProvider` are all consumed here). This is the wave 3 join point — nothing else is unblocked until it lands, so it does not run alongside anything.

**Files:**
- Create: `apps/web/src/app/api/connections/jira/route.ts` — `POST` to connect.
- Modify: `apps/web/src/app/api/connections/[connectionId]/route.ts` — delete the secret alongside the connection.
- Create: `apps/web/src/server/task-provider.ts` — `resolveTaskProvider(orgId, kind)`, the shared "find the org's tasks connection, decrypt its secret, build the provider" helper.
- Modify: `apps/web/src/components/ConnectionsList.tsx` — a Connect Jira action and modal.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` — new `connections.jira.*` keys.
- Modify: `apps/web/src/lib/mock/context.tsx` — refresh connections after a successful connect.
- Test: `apps/web/src/app/api/connections/jira/__tests__/route.test.ts`, `apps/web/e2e/connections-jira.spec.ts`.

**Interfaces:**
- Produces (used by Tasks 5 and 6): `resolveTaskProvider(orgId)` returning `{ connection, provider } | undefined`. Its "first `kind === "tasks"` connection" is safe to treat as *the* connection, not an arbitrary one, because Step 2 below makes a second one unreachable (Design decision 15).

- [ ] **Step 1: Write the failing route test**

Cover: unauthenticated → 401; a `verify()` failure → 400 with a message the UI can show, **and no rows written** (neither a secret nor a connection — this is the case that leaves orphans if written in the wrong order); success → 201 with a `Connection` body whose JSON contains neither the token nor the string `credentialRef`; **the org already has any `kind: "tasks"` connection (same Jira site, a different Jira site, or — once it exists — a different provider entirely) → 409, and `verify()` is never called** (assert the stubbed Jira `myself` endpoint got zero requests — this is Design decision 15, not the narrower "same site" check a first read might expect). After deleting that existing connection, a second `POST` succeeds normally.

- [ ] **Step 2: Implement `POST /api/connections/jira`**

Body: `{ siteUrl, accountEmail, apiToken, label? }`. **First, before anything else:** `listConnections(orgId)` and check for an existing `kind === "tasks"` row (any provider) — return `409` naming it (`"Already connected to {label}. Disconnect it before connecting another."`) and stop; this is the cheapest possible check, so it goes before `verify()`, not after, to avoid a wasted Jira API call on a request that was always going to fail. Normalise `siteUrl` (strip trailing slash, require `https:`, reject a non-`atlassian.net` host only if the team decides Cloud-only in the spec sign-off). Order from here matters: **`verify()`, then write the secret, then write the connection.** Store `auth: "api_token"`, `kind: "tasks"`, `provider: "jira"`, and a `config` of `{ siteUrl, accountEmail, accountId, writeBack: { comment: true } }` — note `config` is public by construction, so `accountId` is fine there and `apiToken` never is.

- [ ] **Step 3: Cascade the secret on disconnect**

In the existing `DELETE /api/connections/[connectionId]` route, after the `getConnection(orgId, id)` org check that is already there, call `deleteConnectionSecret(orgId, connection.credentialRef)` when set, then `deleteConnection`. The FK is `set null`, so the order is not load-bearing for integrity, but deleting the secret first means a failure midway leaves a broken connection rather than an unreferenced credential sitting in the table.

- [ ] **Step 4: Implement `resolveTaskProvider`**

`listConnections(orgId)` → first `kind === "tasks"` connection → `readConnectionSecret` → `createTaskProvider`. Returns `undefined` when the org has no tasks connection. On a `ProviderError` with `isAuthFailure`, call `setConnectionHealth(orgId, id, "expired")`; on any other `ProviderError`, `"needs-attention"`. This is the first real writer of `connections.health`.

- [ ] **Step 5: Build the Connections UI**

In `ConnectionsList.tsx`, replace the hardcoded Connect GitHub button with a small provider-driven list so adding Slack later is data, not another branch. Add a Jira modal (site URL, account email, API token) using `TextInput` and `Button` from `@agentfactory/shared`. On submit, `apiFetch` the new route; on error show the message returned. Include a line in the modal recommending a dedicated Jira service account, because an API token carries the full permissions of the human who minted it — this is the spec's headline risk and the UI is where it lands.

- [ ] **Step 6: Add i18n keys**

Fill in the `connections.jira` object Task 1, Step 7 already created (empty) with `connect`, `modalTitle`, `siteUrl`, `siteUrlHelp`, `accountEmail`, `apiToken`, `apiTokenHelp`, `serviceAccountWarning`, `verifyFailed`, `alreadyConnected`. This object belongs to this task alone — Task 6 fills in the sibling `connections.jiraWriteBack` object instead, so the two never touch the same keys even when dispatched in the same wave. `connections.provider.jira` and `connections.kind.tasks` already exist.

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm test:unit && pnpm test:e2e`
Expected: the E2E spec connects a stubbed Jira site and asserts the API token appears in no response body.

```bash
git add apps/web/src/app/api/connections/jira apps/web/src/app/api/connections/\[connectionId\]/route.ts \
  apps/web/src/server/task-provider.ts apps/web/src/components/ConnectionsList.tsx \
  apps/web/src/lib/i18n/dictionaries/en.ts apps/web/src/lib/mock/context.tsx apps/web/e2e/connections-jira.spec.ts
git commit -m "feat(web): connect a Jira Cloud site as a tasks connection

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Create a task from a Jira issue, with its attachments

**Depends on Task 4** (`resolveTaskProvider`, the connect flow). **Parallelizable with:** Task 6 — both depend only on Task 4, and neither's code path touches a file the other modifies. See "Parallel execution" above for the `en.ts` split that makes this safe.

**Files:**
- Create: `apps/web/src/app/api/connections/tasks/issue/route.ts` — `GET ?ref=<text>`. Named for the
  connection kind, not the provider — see the spec's Design decision 14 — even though `createTaskProvider` only resolves to a Jira adapter today.
- Modify: `apps/web/src/app/(app)/tasks/new/page.tsx` — a **From issue** input, disabled with a
  `TooltipBubble` when `connections.find(c => c.kind === "tasks")` is `undefined`, otherwise enabled
  and labeled from that connection's `provider` (dynamic label — see Step 3), that prefills the form
  and shows fetched attachments.
- Modify: `apps/web/src/app/api/tasks/route.ts` — accept and persist `externalRef` (including `lastKnownUpdated`).
- Modify: `packages/db/src/repositories/task-context-items.ts` — accept an optional `source` on `NewTaskContextItem` (default `"upload"`).
- Modify: the task detail page — render a linked-issue badge (labeled from `externalRef.provider`,
  not hardcoded) linking to `externalRef.url`, and list the task's `task_context_items` with a
  status indicator.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` — fills in `taskCreate.linkedIssue` and `taskDetail.linkedIssue` only (both pre-created empty by Task 1, Step 7; owned exclusively by this task).
- Test: `apps/web/src/app/api/connections/tasks/issue/__tests__/route.test.ts`, `packages/db/src/__tests__/repositories/task-context-items.test.ts`, plus an E2E addition.

**Interfaces:**
- Produces (used by Task 7): the same `GET /api/connections/tasks/issue` route, reused for the refresh flow.

- [ ] **Step 1: Write the failing route test**

Cover: no tasks connection for the org → 404 with a code the UI can branch on (so it can say "connect a task-tracking tool first" rather than "not found"); `ref` parses to nothing → 400; issue not found → 404; success → `ExternalIssue` including `attachments` and `updated`. Add the cross-org case explicitly: a `ref` that is a browse URL for a *different* Atlassian site than the org's connection must be rejected by `parseIssueReference` (Task 3, Step 2) and never fetched.

- [ ] **Step 2: Implement the route**

`resolveTaskProvider(orgId)` → `parseIssueReference(ref)` → `fetchIssue(key)`. Return `ExternalIssue` directly; it is already provider-neutral. This route only reads the issue — it does not yet download attachment bytes or write anything; that happens in Step 4, once a task actually exists to attach them to.

- [ ] **Step 3: Wire the task form**

The **From issue** field: disabled, wrapped in `group/tooltip relative` with a `TooltipBubble`
reading *"Connect a task-tracking tool in Settings → Connections to link an issue"*, whenever
`connections.find(c => c.kind === "tasks")` is `undefined` — `connections` is already in
`useMockBackend()`'s state, no new fetch. Once one exists, enable the field and set its label to
`t("taskCreate.linkedIssue.fromIssueLabel", { provider: t(\`connections.provider.${conn.provider}\`) })`
(today this always resolves to "From Jira issue," purely because Jira is the only connected
provider possible — the label is never hardcoded). It accepts a key or a URL, with a Fetch action.
On success set Title from `issue.title` and Description from `issue.description`, hold
`{ provider: conn.provider, key, url, lastKnownUpdated: issue.updated }` in form state (the
provider comes from the resolved connection, not a literal `"jira"`), and show `issue.attachments`
as a read-only list (filename, size) so the user sees what will come along before they save. All
fields stay editable — the prefill is a starting point, and the user may well rewrite it.

**Acceptance criteria are deliberately not auto-extracted** from the description in this pass (spec, "Flow: create a task from an issue"). Leave the existing AC editor untouched and empty.

**Why prefill at creation rather than fetch at run time.** GitHub takes the other route: `worker.ts:225-246` parses a GitHub issue link out of `task.description` on every run and injects the fetched body into the prompt as `issueContext`, because the sandbox has no credentials and the issue text exists nowhere else. Jira does not need that, because the prefill copies the issue body *into* `task.description`, which the prompt already carries. Prefill also leaves the text editable, which matters when the Jira issue is written for a human and needs tightening for an agent. Do **not** add a second run-time Jira fetch to `worker.ts` — it would re-fetch on every run of every linked task, for content already in the prompt.

- [ ] **Step 4: Persist the link and ingest the attachments**

`POST /api/tasks` accepts `externalRef` and passes it to `createTask`. Immediately after the task is created (same request, same route — there is no task id to attach documents to before this point), for each `ExternalAttachment` in the issue fetched in Step 2:

```ts
const bytes = await provider.fetchAttachment(attachment);
const { sha256, sizeBytes } = await getBlobStore().put(orgId, bytes, attachment.mime);
await insertContentBlob(orgId, sha256, sizeBytes, attachment.mime);
const item = await createTaskContextItem({
  taskId: task.id, orgId, title: attachment.filename,
  sizeBytes, sha256, mime: attachment.mime, source: "jira",
});
if (item) await enqueueTaskContextIngestJob(item.id);
```

This is the same sequence as `apps/web/src/app/api/tasks/[taskId]/context-items/route.ts`'s `POST` handler, not a new one — see the spec's "A task-scoped attachment pipeline already exists, unwired." Skip an attachment whose `sizeBytes` exceeds `MAX_UPLOAD_BYTES` (import the constant from that route rather than redefining it) and continue with the rest — one oversized attachment must not drop the others. `item` comes back `undefined` on a duplicate `(taskId, sha256)`, which cannot happen on task creation (a fresh task has no prior items) but will once Task 7's refresh re-runs this same loop — handle it as a no-op there too, not an error.

- [ ] **Step 5: Display the link and its attachments**

The task detail page renders a linked-issue badge (`t("taskDetail.linkedIssue.badge", { provider:
t(\`connections.provider.${task.externalRef.provider}\`), key: task.externalRef.key })` — reads
"Jira PROJ-123" today, generically for whatever provider the task is actually linked to) beside the
existing PR link when `task.externalRef` is set, and — beside or below it — the task's
`task_context_items` (via `listTaskContextItemsForOrg`) as a small list: filename, and a badge
distinguishing `"indexed"` (available to the agent) from `"failed"`/`"pending"` (not yet, with a
link to view the original via `externalRef.url` for the failed case, since the bytes exist but were
never surfaced as readable).

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm test:unit`

```bash
git add apps/web/src/app/api/connections/tasks/issue apps/web/src/app/api/tasks/route.ts \
  "apps/web/src/app/(app)/tasks" apps/web/src/lib/i18n/dictionaries/en.ts \
  packages/db/src/repositories/task-context-items.ts packages/db/src/__tests__/repositories/task-context-items.test.ts
git commit -m "feat(web): create a task from a Jira issue reference, with its attachments

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Worker write-back on PR open

**Depends on Task 4 only** (`connections/jira/route.ts` to extend with a `PATCH`, and the connect flow's `auth`/secret shape). This is looser than it might read at first: write-back only needs a task's `externalRef` (Task 1's type, already available) and the pattern `apps/web/src/server/task-provider.ts` (Task 4) sets — it does not import or depend on anything Task 5 creates. **Parallelizable with:** Task 5 — see "Parallel execution" above, including the note there on this task's one-line, low-conflict touch to the task detail page (shared with Task 5) and its own top-level `writeBackFailure` i18n object (not shared with Task 5's `taskDetail.linkedIssue`).

**Files:**
- Create: `apps/worker/src/task-notify.ts` — `notifyIssueOfPullRequest`.
- Modify: `apps/worker/src/worker.ts` — one call at the existing PR-open hook.
- Modify: `packages/core/src/domain.ts` — add `writeBackFailure?: { message: string; occurredAt: ISODateTime }` to `TaskExternalRef`. No migration: `tasks.external_ref` is already `jsonb` (Task 1).
- Modify: `apps/web/src/components/ConnectionsList.tsx` — the write-back configuration panel.
- Modify: `apps/web/src/app/api/connections/jira/route.ts` (or a sibling `PATCH`) — persist `config.writeBack`.
- Modify: `apps/web/src/app/(app)/tasks/page.tsx` — the tasks-list warning indicator.
- Create: `apps/web/src/components/WriteBackFailureBanner.tsx` — mirrors `RepoMapWaitBanner.tsx`'s use of `ConfirmationBanner.module.css`.
- Modify: the task detail page — a single `<WriteBackFailureBanner task={task} onDismiss={...} />` mount, above the conversation thread.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` — fills in `connections.jiraWriteBack` (config panel strings; owned exclusively by this task, sibling to Task 4's `connections.jira`) and the top-level `writeBackFailure` object (banner/tooltip/dismiss strings; also exclusive to this task — deliberately not nested under `taskDetail`, which Task 5 also writes to in this same wave).
- Test: `apps/worker/src/__tests__/task-notify.test.ts`, a component test for `WriteBackFailureBanner`, a render test for the tasks-list indicator.

- [ ] **Step 1: Write the failing test**

Five cases, all with a stubbed provider: a task with no `externalRef` is a no-op and makes no provider call; a task with a Jira ref posts a comment containing the PR URL and the task ref; `config.writeBack.transitionTo` set also calls `transitionIssue` with that id; **a provider that throws produces an error event, sets `externalRef.writeBackFailure`, and the function still resolves** — this is the case the Global Constraint exists for, and it is the one most likely to regress; a successful call explicitly leaves `writeBackFailure` unset on the `updateTask` call (a task's first, successful write-back must never appear to have failed).

The error-handling shape to copy is already in the tree: `worker.ts:236-245` wraps `fetchIssue` in a try/catch that emits an `error` event and continues, with a comment explaining that the failure "previously vanished silently". Match it.

- [ ] **Step 2: Implement `notifyIssueOfPullRequest`**

```ts
export async function notifyIssueOfPullRequest(
  orgId: number,
  task: Task,
  pr: { number: number; url: string },
  emitEvent: (type: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void>
```

Resolve the connection and secret the same way `apps/web/src/server/task-provider.ts` does. The worker cannot import from `apps/web`, so this duplicates ~15 lines of resolution logic — which is the established, documented tradeoff (`apps/worker/src/scm-provider.ts:28-30`). If a third consumer appears, move `resolveTaskProvider` into `packages/integrations` and delete both copies.

Wrap the entire body in a try/catch that emits an `error` event and returns. Set connection health on an auth failure, exactly as Task 4 Step 4 does. In the catch, also call `updateTask(task.id, { externalRef: { ...task.externalRef, writeBackFailure: { message, occurredAt: new Date().toISOString() } } })` — a new call this function makes for no other reason, but a small one: `updateTask` already exists (Task 1), takes a partial patch, and this is a one-field write against a row this function has already loaded. On the success path, if `task.externalRef?.writeBackFailure` was already set (a task whose earlier write-back failed and is somehow retried — not possible yet since write-back fires once, but cheap to guard against future retry work), clear it the same way with `writeBackFailure: undefined`.

- [ ] **Step 3: Call it from the worker**

In `apps/worker/src/worker.ts`, immediately after line 418's `await updateTask(task.id, { prNumber: pr.number, prUrl: pr.url, status: "pr_open" });`:

```ts
// Inside the `result.pushed && !task.prNumber` guard on purpose: that guard is what makes PR
// opening happen exactly once per task, so the Jira comment inherits the same once-only
// property for free. Never throws - see task-notify.ts.
await notifyIssueOfPullRequest(agent.orgId, task, pr, (type, data) => createEvent(runId, seq++, type, data));
```

Note `agent.orgId`, not `session.orgId` — `worker.ts` consistently sources the org from the agent (lines 167, 198, 204, 206, 230, 253), and `session` has no `orgId` in scope here.

Confirm `seq` still increments correctly afterwards — it is a mutable counter shared with the surrounding block, and the closure form above matches how the existing GitHub issue-fetch error path at `worker.ts:241-243` uses it.

- [ ] **Step 4: Build the write-back config UI**

For `kind: "tasks"` connections only, a panel with a comment-on-PR toggle and an optional transition target. The transition dropdown is populated by asking the user for a sample issue key and calling `listTransitions` through a new route — transition ids are workflow-scoped and there is no site-wide list to fetch.

- [ ] **Step 5: Add the tasks-list indicator**

In `apps/web/src/app/(app)/tasks/page.tsx`, in the row's status cell, render a small warning glyph wrapped in `TooltipBubble` (`@agentfactory/shared`) when `task.externalRef?.writeBackFailure` is set, tooltip text from `writeBackFailure.listTooltip` (interpolating the stored `message`). No new fetch: `useMockBackend()`'s `tasks` already carries full rows including `externalRef`, since `GET /api/tasks` returns whatever `Task` looks like — confirm the list route doesn't strip `externalRef` before this step assumes it's there.

- [ ] **Step 6: Build the banner and Dismiss**

`WriteBackFailureBanner.tsx` (new): given a `task`, renders nothing if `externalRef?.writeBackFailure` is unset; otherwise renders `confirmationStyles.banner`/`.title`/`.body` (the same classes `RepoMapWaitBanner.tsx` imports from `ConfirmationBanner.module.css`) with the stored `message`, a link to `externalRef.url`, and a **Dismiss** `Button`. Dismiss calls `apiFetch(PATCH /api/tasks/${task.id}, { externalRef: { ...task.externalRef, writeBackFailure: undefined } })` and updates local state so the banner disappears without a reload — that route already forwards its body to `updateTask` unchanged (`apps/web/src/app/api/tasks/[taskId]/route.ts:19-41`), so no route change is needed here. Mount it once, near the top of the task detail page, above the conversation thread — see "Parallel execution" above for why this is a single-line addition to a file Task 5 also touches, not a redesign of that page.

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm test:unit`

```bash
git add apps/worker/src/task-notify.ts apps/worker/src/worker.ts packages/core/src/domain.ts \
  apps/worker/src/__tests__/task-notify.test.ts apps/web/src/components/ConnectionsList.tsx \
  apps/web/src/components/WriteBackFailureBanner.tsx "apps/web/src/app/(app)/tasks" \
  apps/web/src/app/api/connections/jira apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(worker): comment on the linked Jira issue when a run opens a PR, and surface a failure

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Refresh a linked task from Jira, and check for drift before a run

**Depends on Tasks 4–5** (`resolveTaskProvider` from Task 4; the linked-issue badge and persist-and-ingest sequence from Task 5, which this task's Refresh button sits beside and whose logic its "apply" path reuses). Independent of Task 6 — write-back and this staleness check share no code — but not parallelizable with it in practice, since it also needs Task 5, which is itself in the wave before Task 6's earliest possible finish only by coincidence, not by a dependency edge; this task is wave 5, solo, once Task 5 lands.

**Files:**
- Create: `apps/web/src/server/task-sync.ts` — `checkTaskSync(orgId, task)`.
- Create: `apps/web/src/app/api/tasks/[taskId]/sync/route.ts` — `POST` to refresh.
- Modify: `apps/web/src/app/api/tasks/[taskId]/run/route.ts` — the pre-run check.
- Modify: `apps/worker/src/task-documents.ts` — `materialiseTaskDocuments` also names unindexed Jira-sourced items in `omitted`.
- Modify: the task detail page — a Refresh action and the stale-run diff dialog.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` — fills in `taskDetail.sync` only (pre-created empty by Task 1, Step 7; the sibling `taskDetail.linkedIssue` belongs to Task 5, already landed by the time this task starts).
- Test: `apps/web/src/server/__tests__/task-sync.test.ts`, `apps/web/src/app/api/tasks/[taskId]/run/__tests__/route.test.ts` (extend), `apps/worker/src/__tests__/task-documents.test.ts` (extend), plus an E2E addition.

**Interfaces:**
- Produces (used by the run route and the refresh route): `checkTaskSync(orgId: number, task: Task): Promise<{ stale: false } | { stale: true; latest: ExternalIssue }>`.

- [ ] **Step 1: Write the failing test for `checkTaskSync`**

Cover: `task.externalRef` unset or `provider !== "jira"` → `{ stale: false }`, no provider call made; `resolveTaskProvider` returns `undefined` (no Jira connection) → `{ stale: false }`; `fetchIssue` throws (`ProviderError` or a network error) → `{ stale: false }`, not a throw — this is the fail-open case the spec's Design decision 12 requires, and it is the one most likely to regress into "Jira being down blocks every run"; `latest.updated === task.externalRef.lastKnownUpdated` → `{ stale: false }`; a different `updated` → `{ stale: true, latest }`.

- [ ] **Step 2: Implement `checkTaskSync`**

Wrap the whole body in try/catch returning `{ stale: false }` on any error — mirror the shape of `notifyIssueOfPullRequest`'s guard in Task 6, same reasoning, opposite direction (a read that must not block, instead of a write that must not fail the run).

- [ ] **Step 3: Implement `POST /api/tasks/[taskId]/sync`**

`checkTaskSync(orgId, task)`. `{ stale: false }` → `200 { stale: false }`. `{ stale: true, latest }` with `apply: true` in the request body → run the same "persist link + ingest attachments" sequence Task 5 Step 4 uses (title, description, `externalRef` including the new `lastKnownUpdated`, and the attachment loop — which is already a no-op for attachments already stored, by sha256), then `200 { stale: false, applied: true }`. `{ stale: true, latest }` with no `apply` → `200 { stale: true, latest }`, so the caller can render a diff before deciding.

- [ ] **Step 4: Wire the pre-run check into the run route**

In `POST /api/tasks/[taskId]/run`, immediately after loading `task` and before creating the session: if `task.externalRef` is set (any provider — this route has no Jira branch, exactly like `checkTaskSync` itself) and the request body's `acknowledgeStale` is not `true`, call `checkTaskSync(ctx.orgId, task)`. On `{ stale: true, latest }`, return `409 { code: "task_stale", latest }` and create nothing. Otherwise proceed exactly as today. A task with no linked issue, or a request with `acknowledgeStale: true`, never calls `checkTaskSync` at all — no added latency for the common case.

- [ ] **Step 5: Extend `materialiseTaskDocuments`'s omitted list**

In `apps/worker/src/task-documents.ts`, alongside the existing `status === "indexed"` filter that builds `written`, add a second pass over the same `items` list: any item with `status === "failed"` (regardless of source — the filter doesn't need to know about Jira specifically, it only needs to stop ignoring failed items) has its `title` pushed onto `omitted`, the same array budget-overflow titles already go into. No change to `prompt-composition.ts` — it already renders whatever `omitted` contains.

- [ ] **Step 6: Build the Refresh action and the stale-run dialog**

A **Refresh** button next to the linked-issue badge on the task page calls the sync route with no `apply`; `{ stale: false }` shows a brief "up to date" state, `{ stale: true }` opens a dialog (old vs. new title/description, new attachments listed) with **Update task** (calls the route again with `apply: true`) and **Dismiss**. The Run handler catches a `409 task_stale` from the run route and opens the same dialog, with **Update and run** (calls sync with `apply: true`, then re-POSTs run) and **Run anyway** (re-POSTs run with `{ acknowledgeStale: true }`).

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm test:unit`

```bash
git add apps/web/src/server/task-sync.ts apps/web/src/app/api/tasks/\[taskId\]/sync \
  apps/web/src/app/api/tasks/\[taskId\]/run apps/worker/src/task-documents.ts \
  apps/worker/src/__tests__/task-documents.test.ts "apps/web/src/app/(app)/tasks" \
  apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): refresh a Jira-linked task and check for drift before a run

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full suite: `pnpm test`
Expected: unit, db, queue, and E2E all pass.
- [ ] Run `pnpm typecheck` and `pnpm lint` from the repo root.
Expected: no errors across `packages/core`, `packages/db`, `packages/integrations`, `apps/web`, `apps/worker`.
- [ ] **Grep for leaks.** `grep -rn "apiToken\|credentialRef" apps/web/src/app/api` must show writes only, never a value placed on a response body. `grep -rn "atlassian\|jira" apps/worker/sandbox-image packages/core packages/db` must return nothing but the pre-existing `"jira"` enum members in `domain.ts` and `schema.ts`.
- [ ] **Manual end-to-end against a real Jira Cloud site**, which is the only thing that proves the pieces no unit test can cover — that the Basic auth header is accepted, that the ADF comment envelope is well-formed, and that the staleness check behaves under a real clock:
  1. Generate `CONNECTION_SECRET_KEY`, mint a Jira API token, run `pnpm dev:all`.
  2. Connect the site from Settings → Connections. Confirm it appears with health `healthy`. Try
     connecting a second Jira site (or the same one again) — confirm it's rejected with a `409` and
     a message naming the existing connection, and that no second row appears on the Connections page.
  3. Create a task from a real issue that has a `.md` attachment and a screenshot. Confirm title and description prefill, the ADF conversion is readable, the `.md` attachment shows as available and the screenshot shows as not-available-but-listed.
  4. Run the agent on that task through to a pushed PR. Confirm the Jira issue receives a comment containing the PR URL, that the run still reports `pr_open`, and that the agent's transcript shows it read the `.md` attachment from the sandbox and was told the screenshot exists but is not available in its checkout.
  5. Revoke the API token in Atlassian, run another task to PR. Confirm the run **still succeeds**, an error event appears on the transcript, the connection flips to `expired` on the Connections page, a warning indicator appears next to that task on the tasks list, and a banner naming the failure appears on the task detail page.
  6. Click **Dismiss** on that banner. Confirm the banner disappears and the tasks-list indicator disappears too, without a page reload.
  7. Reconnect. Edit the issue's description in Jira. Click **Refresh** on the task page — confirm the diff dialog shows the change, and **Update task** applies it.
  8. Edit the issue again in Jira. Click **Run** without refreshing first — confirm the run does **not** start, the stale dialog appears, **Run anyway** starts a run against the old content, and a fresh **Update and run** on a second attempt starts a run against the new content.
  9. Revoke the API token again and click **Run** on a Jira-linked task. Confirm the run starts normally (the staleness check fails open) rather than blocking.

Step 5 and step 9 are the important ones — both are the same Global Constraint (a Jira problem must never be why a run couldn't happen) applied to the write path and the read path respectively. Step 6 is the other Global Constraint this task adds — a failure surfaces outside the transcript, and Dismiss actually clears it. Everything else is the happy path.

## Follow-ups this plan deliberately does not do

Each is its own spec and plan, and none should be smuggled into a task above:

- **OAuth 2.0 3LO** as a second `JiraAuth` variant — the highest-value follow-up, because an API token carries the full permissions of the human who minted it.
- **Key rotation tooling** for `CONNECTION_SECRET_KEY`. The `keyVersion` column makes it cheap; nothing implements it. Worth doing before anything more sensitive than a scoped Jira token lands in the table.
- **Jira as a trigger source** — blocked on the inbound webhook bus and the `triggers` table (`ARCHITECTURE.md:186-190`), neither of which exists. M5.
- **Jira as an agent-callable MCP tool** (`ARCHITECTURE.md:415`) — blocked on MCP plumbing in the worker, which does not exist, *and* on a way to give the agent provider access without putting a credential where its unrestricted Bash can read it.
- **`agent_connections`** per-agent scope narrowing (`ARCHITECTURE.md:206`). The table does not exist and `agents.connectionIds` is an unenforced jsonb array nothing in the worker reads.
- **Monday / Asana adapters** — the actual proof that the `TaskProvider` port holds, in the same way a second runtime adapter is the proof for `AgentRuntime`.
- **Extracting image and PDF attachments** into something the agent can actually read (OCR, vision, or a PDF-to-text step). Task 7 makes the agent *aware* such attachments exist; it does not make their content legible. This is exactly the gap `text-extract.ts` already names for PDF/.docx uploads generally — Jira attachments hit the same wall, not a new one.
- **A Retry write-back action.** Task 6's Dismiss only clears the failure signal; it does not re-attempt the comment. Write-back fires at most once per task today, so there is no natural second attempt — a real retry needs its own write path (and its own failure handling) this plan does not scope. Worth building if revoked/expired tokens turn out to be a common failure mode in practice.
- **Background attachment ingestion**, if the sequential fetch in Task 5 Step 4 proves too slow for issues with many large attachments. The queue this would use already exists (`enqueueTaskContextIngestJob`); only the "return the task before attachments finish" ordering would be new.
