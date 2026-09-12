# Jira integration — design spec

**Date:** 2026-09-12
**Status:** draft — needs sign-off on the four questions at the end before Task 1 starts
**Issue:** or-borco/AgentFactory#169

> The issue asks us to "flesh out exact requirements … before implementation". This document is
> that answer: it fixes the scope (which Jira actions), the auth model (which credential, stored
> where), and the abstraction boundary (which port, in which package). The companion
> implementation plan is `docs/superpowers/plans/2026-09-12-jira-integration.md`.

## Problem

`ConnectionKind` already admits `"tasks"` and `ConnectionProvider` already lists `"jira"`
(`packages/core/src/domain.ts:135-146`), `sessionOriginEnum` already includes `"jira"`
(`packages/db/src/schema.ts:162`), and the Connections UI already renders a "Jira" label and a
"Task Platform" kind (`apps/web/src/lib/i18n/dictionaries/en.ts:158,166`). None of it is wired to
anything. `docs/ALPHA-SCOPE.md:93` records the gap plainly: *"Only the GitHub connection (scm) is
real; task-system connections are not implemented."*

Concretely, a user who works out of Jira today has to hand-copy an issue's summary, description,
and acceptance criteria into a new AgentFactory task, and then hand-copy the resulting PR link
back into the Jira issue. Both halves of that round trip are mechanical and both are lossy.

## Goal

Make Jira a real `tasks`-kind `Connection`, so that:

1. An org admin can connect a Jira Cloud site from `/connections`.
2. Creating a task from a Jira issue key or URL prefills title, description, and acceptance
   criteria, and records the link.
3. When a run opens a PR for a linked task, the Jira issue gets a comment with the PR URL — and,
   if the connection is configured for it, a status transition.

…without letting a single Jira-shaped type reach `packages/db`, `packages/core`, or any API route
payload.

## Ground truth this design relies on

Verified against the tree at `878d36a`. Several of these contradict `CLAUDE.md`, which still
describes the M0 mock phase; the code is well ahead of it.

- **`connections` has no credential column at all.** The table is
  `{id, orgId, provider, kind, label, health, config, createdAt}`
  (`packages/db/src/schema.ts:146-160`), and its comment says so explicitly: *"No token/secret
  lives here — installation tokens are minted on demand from the platform's GitHub App private
  key … never persisted."* GitHub gets away with this because a GitHub App can mint a scoped,
  hour-lived installation token from a platform-held private key. **Jira has no equivalent.** Both
  Jira auth options (API token, OAuth 2.0 3LO) require persisting a per-connection secret. This
  is the single largest new primitive the integration needs, and nothing in the repo provides it
  today (`grep -ri "encrypt\|vault\|kms"` over `packages/` and `apps/` returns nothing relevant).
- **`ARCHITECTURE.md:206` already specifies the intended shape** — `connections` is
  `{provider, kind, auth, credential_ref, config}` where *"Credential lives in the vault; only a
  reference here."* The `auth` and `credential_ref` columns were simply never built, because
  GitHub never needed them. This design builds them.
- **Neither `ScmProvider` nor `AgentRuntime` is actually an interface yet.**
  `apps/worker/src/scm-provider.ts` is ~555 lines of loose, GitHub-specific exported functions
  (`resolveCloneTarget`, `fetchIssue`, `openDraftPullRequest`, …), each resolving the org's
  connection itself via `listConnections(orgId)` + a `findInstallationForRepo` scoping check.
  `apps/worker/src/agent-runtime.ts` exports a plain `runAgentTurn(params)` function, not the
  `AgentRuntime` port `ARCHITECTURE.md:1` describes. The two ports that *are* real interfaces are
  **`SandboxProvider`** (`apps/worker/src/sandbox/types.ts:1-37`) and **`BlobStore`**
  (`packages/storage/src/blob-store.ts:9-15`). `BlobStore` is the closest template for this work:
  a narrow interface, two adapters, and a `createBlobStore()` factory that reads env *inside* the
  function (never at module scope — its own comment says why) and throws on an unknown kind.
- **`connections` has no writer for `health` and no `updateConnection` at all.** The repository
  (`packages/db/src/repositories/connections.ts`) is `list`/`get`/`create`/`delete` only, so
  `health` is permanently `"healthy"` in practice. `ARCHITECTURE.md:520` names connection health
  as the intended signal for an invalid credential; nothing writes it.
- **`deleteConnection(id)` is not org-scoped** — it is safe today only because the one route that
  calls it pre-checks with `getConnection(orgId, id)` first. Any new call site must do the same.
- **`GET /api/connections` returns `config` verbatim to the browser**
  (`apps/web/src/app/api/connections/route.ts:5-9`). Harmless today (installation ids); a
  credential leak the moment a secret lands in `config`. This is a large part of why the secret
  goes in a separate table rather than in `config`.
- **The Connections UI is one component, and `/connections` is a redirect shim.**
  `apps/web/src/app/(app)/connections/page.tsx` redirects to `/settings` preserving query params;
  `apps/web/src/app/(app)/settings/SettingsView.tsx` embeds `apps/web/src/components/ConnectionsList.tsx`,
  which is the entire UI (a `SECTIONS` kind→i18n map, a `healthTone` map, and a hardcoded
  `/api/connections/github/start` connect button). There is **no** `apps/web/src/server/mock-store.ts`
  despite `CLAUDE.md` — client state lives in `apps/web/src/lib/mock/context.tsx`.
- **GitHub's provider code is duplicated across `apps/web` and `apps/worker` on purpose**, with a
  comment at `apps/worker/src/scm-provider.ts:28-30` explaining it: *"apps/worker and apps/web are
  separate processes/packages with no shared-code path between them today, and this is ~20 lines.
  Revisit if a third consumer needs it."* The Jira adapter is not 20 lines and has two consumers
  from day one (the web connect/verify flow and the worker write-back), so it gets a shared
  workspace package rather than a copy-paste.
- **The sandbox deliberately holds no provider credentials.** `scm-provider.ts:129-135` and
  `cloneIntoSandbox`'s comment spell out why: the agent has unrestricted Bash and no `canUseTool`
  gate, so any token reachable from `/workspace` is a token the agent can use to call the provider
  on its own initiative. GitHub API reads run on the worker host. Jira must do the same.
- **`tasks` has `prNumber`/`prUrl` but no external-reference column** (`packages/db/src/schema.ts:312-350`),
  and `Task` in `domain.ts:225-246` matches. There is nowhere to record "this task is Jira
  PROJ-123" today.
- **The PR-open hook point is exact and singular**: `apps/worker/src/worker.ts:405-418`, guarded by
  `result.pushed && !task.prNumber` so it fires at most once per task. That is where write-back
  belongs.
- **There is no MCP wiring anywhere.** `grep -ri "mcp" apps/worker/src apps/worker/sandbox-image`
  returns nothing; `sandbox-image/run-turn.ts` calls the Claude Agent SDK's `query()` with
  `model`/`systemPrompt`/`cwd`/`permissionMode`/`resume`/`skills`/`thinking` and no server config.
- **There is no webhook bus and no `triggers` table.** `ARCHITECTURE.md:186-190` designs both;
  `ALPHA-SCOPE.md:91-92` confirms neither exists. The only inbound routes are the GitHub App
  install/OAuth callbacks.
- **Tasks are the system of record, not Jira.** `docs/PRODUCT-DEFINITION.md:55`: *"Tasks live in
  AgentFactory, not in Jira."* This is load-bearing for the scope decisions below.

## Scope

### In scope

| # | Capability | Direction | Why |
|---|---|---|---|
| 1 | Connect a Jira Cloud site per org (site URL + account email + API token), verified on save | — | The entry point; nothing else works without it |
| 2 | Read one issue by key or URL: summary, description, status, issue type, labels, URL | Jira → AF | Powers task prefill; mirrors `scm-provider.fetchIssue` |
| 3 | Parse a Jira issue key (`PROJ-123`) or browse URL out of free text | — | Mirrors `scm-provider.parseIssueReference`; the paste-a-link flow is how GitHub issues already work |
| 4 | Link a Task to a Jira issue (`tasks.external_ref`) and surface the link in the task UI | — | Without a stored link there is nothing to write back to |
| 5 | Post a comment on the linked issue when a run opens a PR | AF → Jira | Closes the loop the user currently closes by hand |
| 6 | Optionally transition the linked issue to a configured status when the PR opens | AF → Jira | The other half of that manual loop; opt-in per connection |
| 7 | List available transitions for an issue, so the transition target is picked from a dropdown rather than typed | Jira → AF | Transition IDs are per-project and per-workflow; a free-text field would be a support burden |
| 8 | Encrypted at-rest storage for connection credentials (`connection_secrets` + `connections.credential_ref`) | — | The new primitive (see Ground truth); reusable by Slack/Monday/Asana |

### Out of scope (and why)

- **Creating Jira issues from AgentFactory.** Tasks are the system of record
  (`PRODUCT-DEFINITION.md:55`). Pushing task creation into Jira makes the two systems
  bidirectional, which immediately raises conflict resolution, dedupe, and loop-protection
  questions we have no machinery for. If a team wants a Jira issue, they create it in Jira and
  link it.
- **Continuous status sync.** Same reason, plus it needs polling or webhooks. One write, at one
  well-defined moment (PR opened), is the whole write surface.
- **Jira as a trigger source** ("issue moved to Ready for Dev → run"). Requires the inbound webhook
  bus, the `triggers` table, provider-event-id idempotency, and loop protection — none of which
  exist (`ARCHITECTURE.md:186-190`, `ALPHA-SCOPE.md:91-92`). This is M5 work and should be one
  plan per piece, not smuggled in here.
- **Jira as an agent-callable tool / MCP server.** `ARCHITECTURE.md:415` is the long-term target,
  but there is no MCP plumbing in the worker at all, and exposing Jira to the agent means putting
  a Jira credential where the agent's unrestricted Bash can read it — which contradicts the
  standing sandbox decision. Both problems need solving before this is even a design question.
- **Jira Data Center / Server.** Cloud only. The REST surface and the auth model differ enough
  that supporting both up front doubles the adapter for an audience we do not have.
- **OAuth 2.0 3LO.** Deferred, but *only* as a second `JiraAuth` variant behind the same adapter
  and the same `connection_secrets` row — see Design decisions.
- **Per-agent scope narrowing** (`agent_connections`, per `ARCHITECTURE.md:206`). The table does
  not exist. Connections are org-scoped today and Jira does not change that.

## Design decisions

**1. API token first, OAuth 2.0 3LO second — but both behind one `JiraAuth` union.**
Jira Cloud API tokens are Basic auth (`email:token`), work immediately, need no callback route, no
client registration, no refresh rotation, and no platform-level Atlassian app. OAuth 2.0 3LO is
better (revocable, scoped, no shared password-equivalent) but needs all of the above *plus* the
same encrypted-storage primitive. Building the primitive and the adapter against API tokens gets
capability 1–7 shipped; adding 3LO later is a new `JiraAuth` variant plus a callback route, with
no change to the port, the write-back, or the UI beyond one more button. Shipping 3LO first would
mean shipping nothing for several weeks.

**2. Credentials go in a `connection_secrets` table, referenced by `connections.credential_ref`,
encrypted with AES-256-GCM under a single app-level key.** This is exactly the shape
`ARCHITECTURE.md:206` specifies. A separate table (rather than an encrypted column on
`connections`) means `listConnections` — which the worker calls on nearly every run, and which
feeds the `/api/connections` response — cannot accidentally return ciphertext or a decrypted
secret to a client. The key comes from `CONNECTION_SECRET_KEY` (32 bytes, base64). The envelope
stores the key version so a future rotation is a re-encrypt migration, not a schema change. This
is not a KMS and does not pretend to be; it is defense against a database dump, and the threat
model should be written down as such.

**3. The port is `TaskProvider`, an interface, in a new `packages/integrations` workspace package,
reached through a `createTaskProvider(connection, secret)` factory.**
An interface rather than `scm-provider.ts`-style free functions because the entire reason
`ConnectionKind` has a `"tasks"` member is that Monday and Asana follow. The factory mirrors
`createBlobStore()` (`packages/storage/src/index.ts:14-30`) exactly, including reading
configuration inside the function rather than at module scope, and throwing on an unknown
provider. A shared package rather than the GitHub-style web/worker duplication because the adapter
is several hundred lines and has two consumers on day one; `scm-provider.ts:28-30` already names
"a third consumer" as the trigger to stop duplicating. `packages/core` is the wrong home — it is
types-only with no runtime dependencies, and the adapter makes HTTP calls.

**4. Provider types never cross the package boundary.** `TaskProvider` speaks in
`ExternalIssue { key, title, description, status, issueType, labels, url }` and
`IssueTransition { id, name, toStatus }`. Jira's `fields.summary`, `fields.description` (ADF!),
`fields.issuetype`, and transition payloads are translated inside `JiraTaskProvider` and never
escape it. In particular the Atlassian Document Format → Markdown conversion is an adapter
concern, and the adapter returns plain strings.

**5. All Jira calls run host-side — in the Next.js server or the worker process, never in the
sandbox.** Identical reasoning to `scm-provider.ts`'s clone-token handling: the agent has
unrestricted Bash and no permission gate, so a Jira credential inside `/workspace` is a Jira
credential the agent can spend. The agent never learns the Jira site URL either.

**6. The task↔issue link is a generic `external_ref`, not a `jira_issue_key` column.**
`tasks.external_ref jsonb` holding `{ provider, key, url }` costs nothing extra now and means
Monday/Asana need no migration. It mirrors `sessions.external_thread_ref`'s intent while carrying
the provider, which that column does not.

**7. Write-back failures never fail a run.** A Jira comment is a courtesy, not part of the
deliverable. Every write-back call is wrapped so that a 401, a 404, a revoked token, or an
Atlassian outage produces an `error`-type `RunEvent` on the transcript and nothing else — the run
still reports `pr_open`. This mirrors how `skills-materialize.ts` degrades (returns `[]` and logs
rather than throwing).

**8. Connection health is written, not decorative.** `connections.health` already exists with
`healthy | needs-attention | expired` and is currently always `healthy`. A 401 from Jira flips it
to `expired`; any other 4xx/5xx flips it to `needs-attention`. This is the first real use of the
column and it gives the Connections page something true to show.

## Mechanism

### Schema

Three changes, one migration.

```ts
// packages/db/src/schema.ts

export const connectionAuthKindEnum = pgEnum("connection_auth_kind", ["none", "api_token", "oauth2"]);

export const connectionSecrets = pgTable("connection_secrets", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
  // AES-256-GCM. `ciphertext` is base64(iv || authTag || payload); `keyVersion` lets a future
  // key rotation be a re-encrypt migration rather than a schema change.
  ciphertext: text("ciphertext").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// added to `connections`:
//   auth: connectionAuthKindEnum("auth").notNull().default("none"),
//   credentialRef: integer("credential_ref").references(() => connectionSecrets.id, { onDelete: "set null" }),

// added to `tasks`:
//   externalRef: jsonb("external_ref").$type<TaskExternalRef>(),
```

`connections.auth` defaults to `"none"` so every existing GitHub row is correct without a
backfill. `credential_ref` is nullable for the same reason.

### Core types

```ts
// packages/core/src/domain.ts
export type ConnectionAuthKind = "none" | "api_token" | "oauth2";

export interface TaskExternalRef {
  provider: ConnectionProvider;
  /** Provider-native identifier, e.g. a Jira issue key "PROJ-123". */
  key: string;
  /** Browse URL, stored so the UI can link out without reconstructing it per provider. */
  url: string;
}
```

`Connection` gains `auth: ConnectionAuthKind`. It does **not** gain `credentialRef` — the
reference is a persistence detail the API must never serialise, and `Connection` is what
`/api/connections` returns.

`JiraConnectionConfig` is the non-secret half, stored in `connections.config`:

```ts
{ siteUrl: string; accountEmail: string; accountId: string;
  writeBack: { comment: boolean; transitionTo?: { id: string; name: string } } }
```

### The port

```ts
// packages/integrations/src/task-provider.ts
export interface ExternalIssue {
  key: string; title: string; description: string;
  status: string; issueType: string; labels: string[]; url: string;
}
export interface IssueTransition { id: string; name: string; toStatus: string }

export interface TaskProvider {
  /** Verify the credential and return the authenticated account. Called on connect. */
  verify(): Promise<{ accountId: string; displayName: string }>;
  /** Pull out an issue reference from free text; undefined when there isn't one. */
  parseIssueReference(text: string): string | undefined;
  fetchIssue(key: string): Promise<ExternalIssue | undefined>;
  listTransitions(key: string): Promise<IssueTransition[]>;
  addComment(key: string, body: string): Promise<void>;
  transitionIssue(key: string, transitionId: string): Promise<void>;
}
```

`JiraTaskProvider` implements it over Jira Cloud REST v3
(`/rest/api/3/myself`, `/issue/{key}`, `/issue/{key}/transitions`, `/issue/{key}/comment`) with
Basic auth. A `ProviderError { status, message }` normalises HTTP failures so callers can map
401 → `expired` and everything else → `needs-attention` without reading Atlassian error bodies.

### Flow: connect

`POST /api/connections/jira { siteUrl, accountEmail, apiToken, label }` →
`verify()` → on success, `createConnectionSecret(orgId, { apiToken })` →
`createConnection(orgId, { provider: "jira", kind: "tasks", auth: "api_token", credentialRef, config })`.
The token is never echoed back and never read again by the web app; only the worker and the
verify path decrypt it. Delete cascades the secret row.

### Flow: create a task from an issue

The user pastes `PROJ-123` or a browse URL into the task-creation form.
`GET /api/connections/jira/issue?ref=<text>` resolves the org's Jira connection, parses the ref,
fetches the issue, and returns `ExternalIssue`. The form prefills title and description and stores
`external_ref`. This deliberately mirrors the GitHub issue path that already exists
(`scm-provider.parseIssueReference` + `fetchIssue`), so the interaction is one users have seen.

Acceptance criteria are *not* auto-extracted from the Jira description in this pass. Jira
descriptions are ADF and teams encode ACs a dozen different ways; guessing wrong is worse than
leaving the existing AC editor empty. Revisit with real customer data.

### Flow: write-back

At `apps/worker/src/worker.ts:418`, immediately after
`updateTask(task.id, { prNumber, prUrl, status: "pr_open" })`:

```
if (task.externalRef?.provider === "jira") → notifyIssueOfPullRequest(orgId, task, pr)
```

which resolves the connection, decrypts the credential, posts a comment linking the PR, and — if
`config.writeBack.transitionTo` is set — transitions the issue. Wrapped so nothing it does can
throw into the run. Emits one `RunEvent` either way, so the transcript records what happened.

### UI

All connection UI lives in `apps/web/src/components/ConnectionsList.tsx` (rendered by
`SettingsView`; `/connections` is only a redirect shim). It gains:

- A **Connect Jira** action beside the existing hardcoded **Connect GitHub** button, opening a
  modal (site URL, email, API token). The button pair should become a small provider-driven list
  rather than two hardcoded buttons, so Slack/Monday do not each add another branch.
- A per-connection **Configure** panel, shown only for `kind: "tasks"`, carrying the write-back
  toggles; the transition target is populated from `listTransitions` against a sample issue key
  the user supplies, so the user picks a name rather than typing a numeric id.
- The task creation form gains a "From Jira issue" input; the task detail page shows a Jira badge
  linking to `external_ref.url`, beside the existing PR link.

All strings go through `en.ts` first (`CLAUDE.md`'s i18n rule). `connections.provider.jira` and
`connections.kind.tasks` already exist — note that a missing dictionary key here does **not** fail
the build, because the `connections.provider.${provider}` lookup uses the `(string & {})` escape
hatch in `apps/web/src/lib/i18n/paths.ts:11` and `getByPath` returns the raw path on a miss. New
Jira keys must be added deliberately; the type checker will not catch their absence.

## Testing

- **Unit, `packages/integrations`** — `parseIssueReference` across keys, browse URLs, URLs with
  query strings, and text containing neither; ADF→Markdown for paragraphs, lists, code blocks, and
  links; `fetchIssue`/`listTransitions`/`addComment` against recorded Jira response fixtures with
  a stubbed `fetch`; error mapping for 401/403/404/429/500. Fixtures, not live calls — this is
  also the first concrete instance of `ALPHA-SCOPE.md:36`'s "adapters against recorded provider
  fixtures".
- **Unit, `packages/db`** — encrypt→decrypt round trip; distinct ciphertexts for identical
  plaintext (IV is random); tamper detection (GCM auth tag rejects a flipped byte); a clear error
  when `CONNECTION_SECRET_KEY` is unset or the wrong length.
- **Integration, `packages/db`** — `connection_secrets` CRUD, org scoping, and cascade-on-delete
  from both `orgs` and `connections`.
- **Unit, `apps/worker`** — write-back posts the right body; a provider error produces an event
  and does not throw; a task with no `external_ref` is a no-op.
- **E2E, `apps/web`** — connect flow against a stubbed Jira, with an assertion that the API token
  never appears in any response body.

## PR sequence

| # | PR | Contents | Demoable |
|---|---|---|---|
| 1 | Schema + core types | `connection_secrets` table, `connections.auth`/`credential_ref`, `tasks.external_ref`, migration, `ConnectionAuthKind`/`TaskExternalRef`, `updateConnection` + a health writer | No — no behaviour change |
| 2 | Credential storage | AES-256-GCM helpers in `packages/db`, `connection-secrets` repository, unit + integration tests | No |
| 3 | The port + the adapter | `packages/integrations`: `TaskProvider`, `createTaskProvider`, `JiraTaskProvider`, ADF→Markdown, recorded fixtures | No — but the adapter is fully unit-tested |
| 4 | Connect Jira | `POST /api/connections/jira`, verify-on-save, secret cascade on delete, Connections UI + i18n | **Yes** — a Jira site appears on the Connections page |
| 5 | Task ← issue | `GET /api/connections/jira/issue`, task-form prefill, `external_ref` persisted, Jira badge on task detail | **Yes** — paste `PROJ-123`, get a filled-in task |
| 6 | Write-back | `notifyIssueOfPullRequest` at the `worker.ts:418` hook point, config panel for comment/transition toggles | **Yes** — run an agent, watch the Jira issue get a PR comment |

1–3 are independently mergeable and invisible to users; each can land while the next is in review.
4 makes Jira connectable, 5 makes it useful, 6 closes the loop.

## Risks

- **The encryption key is a single point of failure.** Losing `CONNECTION_SECRET_KEY` orphans
  every stored credential (recoverable — users reconnect); leaking it alongside a DB dump defeats
  the encryption entirely. The `keyVersion` column keeps rotation cheap, but rotation tooling is
  not in this plan and should be a follow-up before anything more sensitive than a scoped Jira
  token lands in the table.
- **API tokens are account-scoped, not app-scoped.** A Jira API token carries the full permissions
  of the human who minted it. That is strictly worse than a GitHub App installation token and is
  the strongest argument for prioritising OAuth 2.0 3LO right after this ships. The connect UI
  should say so out loud and recommend a dedicated service account.
- **ADF conversion will be imperfect.** Jira descriptions can contain panels, macros, tables, and
  attachments that have no clean Markdown equivalent. The adapter should degrade to plain text
  rather than emit broken Markdown, and the prefill is user-editable before the task is saved.
- **Transition IDs are workflow-scoped.** A transition valid for one project may not exist in
  another. Storing a transition on the *connection* assumes one workflow per site. If that proves
  wrong in practice, the setting moves to the task or the agent — a config-shape change, not an
  architectural one.
- **Rate limits.** Atlassian applies per-site rate limits with `Retry-After`. The write-back path
  is low-volume (once per task), but the adapter should honour `Retry-After` with a bounded retry
  rather than treating a 429 as a hard failure.

## Decisions that need sign-off before Task 1 starts

These are genuinely product calls, not engineering ones, and the issue explicitly asks for them
to be settled first:

1. **API token before OAuth 2.0 3LO** — accepted risk of an account-scoped credential in exchange
   for shipping weeks earlier?
2. **No issue creation, no continuous sync** — is "AgentFactory is the system of record, Jira is a
   linked upstream" the right product stance, or do users expect tasks to appear in Jira?
3. **Transition-on-PR-open, configured per connection** — or is transitioning too opinionated to
   do automatically at all, leaving only the comment?
4. **Cloud only** — is there a known Data Center user we would be excluding?
