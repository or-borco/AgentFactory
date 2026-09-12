# Jira Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an org connect a Jira Cloud site, create an AgentFactory task from a Jira issue by pasting its key or URL, and have the linked Jira issue receive a comment (and optionally a status transition) when a run opens the pull request.

**Architecture:** A new `connection_secrets` table plus `connections.auth`/`credential_ref` gives the platform its first encrypted credential store (AES-256-GCM under `CONNECTION_SECRET_KEY`), built exactly as `ARCHITECTURE.md:205` specifies. A new `packages/integrations` workspace package holds a `TaskProvider` port and its first adapter `JiraTaskProvider`, reached through a `createTaskProvider()` factory modelled on `createBlobStore()`; no Jira-shaped type leaves that package. `apps/web` gains a connect/verify route and a Connections UI action; `apps/worker` gains a single write-back call at the existing one-shot PR-open hook point in `worker.ts`. Nothing in the sandbox, the prompt-composition pipeline, or the `AgentRuntime` path changes.

**Tech Stack:** TypeScript, pnpm workspace, Next.js 16 App Router, Drizzle ORM / Postgres, `node:crypto`, Vitest (`pnpm test:unit`, `pnpm test:db`), Playwright (`pnpm test:e2e`).

**Spec:** `docs/superpowers/specs/2026-09-12-jira-integration-design.md` — read it before starting any task; this plan implements it task-by-task and does not repeat its rationale.

> **Blocked on sign-off.** The spec closes with four product questions (API-token-before-OAuth, no issue creation / no continuous sync, transition-on-PR-open, Cloud-only). Task 1 must not start until those are answered — a "no" to any of them changes the schema or the scope, not just the code.

## Global Constraints

- **No Jira-shaped type may appear in `packages/core`, `packages/db`, or any API route payload.** `fields.summary`, ADF nodes, transition payloads, and Atlassian error bodies are translated inside `packages/integrations/src/jira/` and never escape it. This is the `AgentRuntime`/`ScmProvider` rule from `ARCHITECTURE.md` applied to the `tasks` kind, and it is the single constraint most likely to be violated by accident.
- **No credential is ever returned by an API route, logged, or written into `connections.config`.** `GET /api/connections` already returns `config` verbatim to the browser (`apps/web/src/app/api/connections/route.ts:5-9`), so `config` is a public field by construction. Secrets live only in `connection_secrets.ciphertext`.
- **No credential reaches the sandbox.** Every Jira HTTP call runs in the Next.js server process or the worker host process. Do not add a Jira env var to the sandbox spec, and do not pass a site URL or token through `runAgentTurn`. See `apps/worker/src/scm-provider.ts:218-276` for the standing reasoning.
- **Write-back never fails a run.** Every call in Task 6 is wrapped so a provider error emits a `RunEvent` and returns; the run still reports `pr_open`. Mirror `skills-materialize.ts`, which returns `[]` and logs rather than throwing.
- Every new repository function and API route is org-scoped. Note that the existing `deleteConnection(id)` is **not** org-scoped — any new call site must pre-check with `getConnection(orgId, id)`, as `apps/web/src/app/api/connections/[connectionId]/route.ts` already does.
- All user-facing strings are added to `apps/web/src/lib/i18n/dictionaries/en.ts` first. Be deliberate: `connections.provider.${provider}` lookups use the `(string & {})` escape hatch in `paths.ts:11`, so a missing key fails silently at runtime rather than at compile time.
- No em dashes in user-facing strings this plan adds.
- Run `pnpm typecheck` and the relevant suite before every commit in every task. **Tests are run from the repo root, not per package** — `vitest.config.ts` defines three projects that glob across the whole workspace, and packages like `packages/storage` have no `test` script at all. Placement decides which project picks a file up: anything at `**/src/**/__tests__/**/*.test.ts` runs under `pnpm test:unit`, except `packages/db/src/__tests__/repositories/**`, which is excluded from `unit` and runs under `pnpm test:db` against a real database with `fileParallelism: false`. Put a test in the wrong directory and it either never runs or tries to reach Postgres from the unit suite.

---

### Task 1: Schema, core types, and the missing connection writers

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

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm test:db`
Expected: no errors; all existing connection and task repository tests still pass. `pnpm test:db` needs Postgres up (`docker compose up -d`).

```bash
git add packages/db/src/schema.ts packages/db/drizzle packages/core/src/domain.ts \
  packages/db/src/repositories/connections.ts packages/db/src/repositories/tasks.ts \
  packages/db/src/__tests__/repositories/connections.test.ts packages/db/src/__tests__/repositories/tasks.test.ts
git commit -m "feat(db): add connection_secrets, connection auth kind, and task external refs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Credential encryption and the connection-secrets repository

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
export interface ExternalIssue {
  key: string; title: string; description: string;
  status: string; issueType: string; labels: string[]; url: string;
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
  listTransitions(key: string): Promise<IssueTransition[]>;
  addComment(key: string, body: string): Promise<void>;
  transitionIssue(key: string, transitionId: string): Promise<void>;
}

export function createTaskProvider(connection: Connection, secret: Record<string, string>): TaskProvider;
```

`createTaskProvider` switches on `connection.provider` and throws a clear error for a provider it does not implement — the same shape as `createBlobStore()` (`packages/storage/src/index.ts:14-30`).

- [ ] **Step 5: Write `JiraTaskProvider` and its test, test first**

Record fixtures for `GET /rest/api/3/myself`, `GET /rest/api/3/issue/{key}`, `GET /rest/api/3/issue/{key}/transitions`, and the error bodies for 401, 404, and 429. The test stubs `globalThis.fetch` and asserts: the `Authorization` header is `Basic base64(email:token)`; `fetchIssue` maps `fields.summary` → `title`, ADF `fields.description` → Markdown, `fields.status.name` → `status`, `fields.issuetype.name` → `issueType`, `fields.labels` → `labels`, and builds `url` from the connection's `siteUrl`; a 404 returns `undefined` rather than throwing (an issue that does not exist is a normal user outcome); a 401 throws `ProviderError` with `isAuthFailure === true`; a 429 is retried once after honouring `Retry-After` (bounded — one retry, capped delay) and then throws.

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

**Depends on Tasks 1–3.**

**Files:**
- Create: `apps/web/src/app/api/connections/jira/route.ts` — `POST` to connect.
- Modify: `apps/web/src/app/api/connections/[connectionId]/route.ts` — delete the secret alongside the connection.
- Create: `apps/web/src/server/task-provider.ts` — `resolveTaskProvider(orgId, kind)`, the shared "find the org's tasks connection, decrypt its secret, build the provider" helper.
- Modify: `apps/web/src/components/ConnectionsList.tsx` — a Connect Jira action and modal.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` — new `connections.jira.*` keys.
- Modify: `apps/web/src/lib/mock/context.tsx` — refresh connections after a successful connect.
- Test: `apps/web/src/app/api/connections/jira/__tests__/route.test.ts`, `apps/web/e2e/connections-jira.spec.ts`.

**Interfaces:**
- Produces (used by Tasks 5 and 6): `resolveTaskProvider(orgId)` returning `{ connection, provider } | undefined`.

- [ ] **Step 1: Write the failing route test**

Cover: unauthenticated → 401; a `verify()` failure → 400 with a message the UI can show, **and no rows written** (neither a secret nor a connection — this is the case that leaves orphans if written in the wrong order); success → 201 with a `Connection` body whose JSON contains neither the token nor the string `credentialRef`; a second connect for the same site → 409 rather than a duplicate.

- [ ] **Step 2: Implement `POST /api/connections/jira`**

Body: `{ siteUrl, accountEmail, apiToken, label? }`. Normalise `siteUrl` (strip trailing slash, require `https:`, reject a non-`atlassian.net` host only if the team decides Cloud-only in the spec sign-off). Order matters: **`verify()` first, then write the secret, then write the connection.** Store `auth: "api_token"`, `kind: "tasks"`, `provider: "jira"`, and a `config` of `{ siteUrl, accountEmail, accountId, writeBack: { comment: true } }` — note `config` is public by construction, so `accountId` is fine there and `apiToken` never is.

- [ ] **Step 3: Cascade the secret on disconnect**

In the existing `DELETE /api/connections/[connectionId]` route, after the `getConnection(orgId, id)` org check that is already there, call `deleteConnectionSecret(orgId, connection.credentialRef)` when set, then `deleteConnection`. The FK is `set null`, so the order is not load-bearing for integrity, but deleting the secret first means a failure midway leaves a broken connection rather than an unreferenced credential sitting in the table.

- [ ] **Step 4: Implement `resolveTaskProvider`**

`listConnections(orgId)` → first `kind === "tasks"` connection → `readConnectionSecret` → `createTaskProvider`. Returns `undefined` when the org has no tasks connection. On a `ProviderError` with `isAuthFailure`, call `setConnectionHealth(orgId, id, "expired")`; on any other `ProviderError`, `"needs-attention"`. This is the first real writer of `connections.health`.

- [ ] **Step 5: Build the Connections UI**

In `ConnectionsList.tsx`, replace the hardcoded Connect GitHub button with a small provider-driven list so adding Slack later is data, not another branch. Add a Jira modal (site URL, account email, API token) using `TextInput` and `Button` from `@agentfactory/shared`. On submit, `apiFetch` the new route; on error show the message returned. Include a line in the modal recommending a dedicated Jira service account, because an API token carries the full permissions of the human who minted it — this is the spec's headline risk and the UI is where it lands.

- [ ] **Step 6: Add i18n keys**

Add a `connections.jira` block to `en.ts` (`connect`, `modalTitle`, `siteUrl`, `siteUrlHelp`, `accountEmail`, `apiToken`, `apiTokenHelp`, `serviceAccountWarning`, `verifyFailed`, `alreadyConnected`). `connections.provider.jira` and `connections.kind.tasks` already exist.

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

### Task 5: Create a task from a Jira issue

**Depends on Task 4.**

**Files:**
- Create: `apps/web/src/app/api/connections/jira/issue/route.ts` — `GET ?ref=<text>`.
- Modify: `apps/web/src/app/(app)/tasks/new/page.tsx` — a "From Jira issue" input that prefills the form.
- Modify: `apps/web/src/app/api/tasks/route.ts` — accept and persist `externalRef`.
- Modify: the task detail page — render a Jira badge linking to `externalRef.url`.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts`.
- Test: `apps/web/src/app/api/connections/jira/issue/__tests__/route.test.ts`, plus an E2E addition.

- [ ] **Step 1: Write the failing route test**

Cover: no tasks connection for the org → 404 with a code the UI can branch on (so it can say "connect Jira first" rather than "not found"); `ref` parses to nothing → 400; issue not found → 404; success → `ExternalIssue`. Add the cross-org case explicitly: a `ref` that is a browse URL for a *different* Atlassian site than the org's connection must be rejected by `parseIssueReference` (Task 3, Step 2) and never fetched.

- [ ] **Step 2: Implement the route**

`resolveTaskProvider(orgId)` → `parseIssueReference(ref)` → `fetchIssue(key)`. Return `ExternalIssue` directly; it is already provider-neutral.

- [ ] **Step 3: Wire the task form**

An input above Title accepting a key or a URL, with a Fetch action. On success set Title from `issue.title` and Description from `issue.description`, and hold `{ provider: "jira", key, url }` in form state. All fields stay editable — the prefill is a starting point, and the user may well rewrite it.

**Acceptance criteria are deliberately not auto-extracted** from the description in this pass (spec, "Flow: create a task from an issue"). Leave the existing AC editor untouched and empty.

**Why prefill at creation rather than fetch at run time.** GitHub takes the other route: `worker.ts:225-246` parses a GitHub issue link out of `task.description` on every run and injects the fetched body into the prompt as `issueContext`, because the sandbox has no credentials and the issue text exists nowhere else. Jira does not need that, because the prefill copies the issue body *into* `task.description`, which the prompt already carries. Prefill also leaves the text editable, which matters when the Jira issue is written for a human and needs tightening for an agent. Do **not** add a second run-time Jira fetch to `worker.ts` — it would re-fetch on every run of every linked task, for content already in the prompt.

- [ ] **Step 4: Persist and display the link**

`POST /api/tasks` accepts `externalRef` and passes it to `createTask`. The task detail page renders a Jira badge beside the existing PR link when `task.externalRef` is set.

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm test:unit`

```bash
git add apps/web/src/app/api/connections/jira/issue apps/web/src/app/api/tasks/route.ts \
  "apps/web/src/app/(app)/tasks" apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): create a task from a Jira issue reference

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Worker write-back on PR open

**Depends on Tasks 1–5.**

**Files:**
- Create: `apps/worker/src/task-notify.ts` — `notifyIssueOfPullRequest`.
- Modify: `apps/worker/src/worker.ts` — one call at the existing PR-open hook.
- Modify: `apps/web/src/components/ConnectionsList.tsx` — the write-back configuration panel.
- Modify: `apps/web/src/app/api/connections/jira/route.ts` (or a sibling `PATCH`) — persist `config.writeBack`.
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts`.
- Test: `apps/worker/src/__tests__/task-notify.test.ts`.

- [ ] **Step 1: Write the failing test**

Four cases, all with a stubbed provider: a task with no `externalRef` is a no-op and makes no provider call; a task with a Jira ref posts a comment containing the PR URL and the task ref; `config.writeBack.transitionTo` set also calls `transitionIssue` with that id; **a provider that throws produces an error event and the function still resolves** — this is the case the Global Constraint exists for, and it is the one most likely to regress.

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

Wrap the entire body in a try/catch that emits an `error` event and returns. Set connection health on an auth failure, exactly as Task 4 Step 4 does.

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

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm test:unit`

```bash
git add apps/worker/src/task-notify.ts apps/worker/src/worker.ts \
  apps/worker/src/__tests__/task-notify.test.ts apps/web/src/components/ConnectionsList.tsx \
  apps/web/src/app/api/connections/jira apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(worker): comment on the linked Jira issue when a run opens a PR

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full suite: `pnpm test`
Expected: unit, db, queue, and E2E all pass.
- [ ] Run `pnpm typecheck` and `pnpm lint` from the repo root.
Expected: no errors across `packages/core`, `packages/db`, `packages/integrations`, `apps/web`, `apps/worker`.
- [ ] **Grep for leaks.** `grep -rn "apiToken\|credentialRef" apps/web/src/app/api` must show writes only, never a value placed on a response body. `grep -rn "atlassian\|jira" apps/worker/sandbox-image packages/core packages/db` must return nothing but the pre-existing `"jira"` enum members in `domain.ts` and `schema.ts`.
- [ ] **Manual end-to-end against a real Jira Cloud site**, which is the only thing that proves the two pieces no unit test can cover — that the Basic auth header is accepted, and that the ADF comment envelope is well-formed:
  1. Generate `CONNECTION_SECRET_KEY`, mint a Jira API token, run `pnpm dev:all`.
  2. Connect the site from Settings → Connections. Confirm it appears with health `healthy`.
  3. Create a task by pasting a real issue key. Confirm title and description prefill and that the ADF conversion is readable.
  4. Run the agent on that task through to a pushed PR. Confirm the Jira issue receives a comment containing the PR URL, and that the run still reports `pr_open`.
  5. Revoke the API token in Atlassian, run another task to PR. Confirm the run **still succeeds**, an error event appears on the transcript, and the connection flips to `expired` on the Connections page.

Step 5 is the important one. Everything else is the happy path; that step is the Global Constraint under test.

## Follow-ups this plan deliberately does not do

Each is its own spec and plan, and none should be smuggled into a task above:

- **OAuth 2.0 3LO** as a second `JiraAuth` variant — the highest-value follow-up, because an API token carries the full permissions of the human who minted it.
- **Key rotation tooling** for `CONNECTION_SECRET_KEY`. The `keyVersion` column makes it cheap; nothing implements it. Worth doing before anything more sensitive than a scoped Jira token lands in the table.
- **Jira as a trigger source** — blocked on the inbound webhook bus and the `triggers` table (`ARCHITECTURE.md:186-190`), neither of which exists. M5.
- **Jira as an agent-callable MCP tool** (`ARCHITECTURE.md:415`) — blocked on MCP plumbing in the worker, which does not exist, *and* on a way to give the agent provider access without putting a credential where its unrestricted Bash can read it.
- **`agent_connections`** per-agent scope narrowing (`ARCHITECTURE.md:206`). The table does not exist and `agents.connectionIds` is an unenforced jsonb array nothing in the worker reads.
- **Monday / Asana adapters** — the actual proof that the `TaskProvider` port holds, in the same way a second runtime adapter is the proof for `AgentRuntime`.
