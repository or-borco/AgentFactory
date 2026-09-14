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
   criteria, records the link, and pulls in the issue's attachments so the agent is aware of them.
3. When a run opens a PR for a linked task, the Jira issue gets a comment with the PR URL — and,
   if the connection is configured for it, a status transition.
4. A task linked to Jira can be refreshed on demand, and is checked for drift the moment a user
   starts a run, so the agent never works from a copy that is silently out of date.

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
- **A task-scoped attachment pipeline already exists, unwired.** `task_context_items` +
  `content_blobs` (`packages/db/src/schema.ts:516-556`) is a complete, content-addressed,
  per-task document store — its own comment says so explicitly: *"Unwired for now — no route, no
  worker, no retrieval reads this table yet."* The upload route
  (`apps/web/src/app/api/tasks/[taskId]/context-items/route.ts`) already does exactly the
  sequence a Jira attachment needs: `BlobStore.put` → `insertContentBlob` →
  `createTaskContextItem` → `enqueueTaskContextIngestJob`. This is the primitive to reuse, not a
  new one to build.
- **That pipeline only extracts text today.** `text-extract.ts:1-4`: *"Ingestion accepts plain
  text and markdown only; PDF and .docx are each one later, isolated PR."* An item whose mime
  isn't in `SUPPORTED_MIMES` makes `extractText` throw `UnsupportedMimeError`, which the ingest
  handler already catches and turns into `status: "failed"` with that message — this is existing,
  tested behaviour, not something this design has to build. It matters because most Jira
  attachments (screenshots, exported PDFs) will land there.
- **Only `status: "indexed"` items reach the agent, and only as whole files, not search hits.**
  `apps/worker/src/task-documents.ts:86-89` filters to `status === "indexed"` before writing
  documents into `/workspace/<TASK_DOCUMENT_DIR>` — this is a separate, simpler path than the
  embedding-based `context-retrieval.ts`, and it runs before every turn regardless of what the
  agent asks for. A `"failed"` item (which is what an image or PDF attachment becomes today) is
  currently silently excluded — `materialiseTaskDocuments` never looks at failed items at all.
- **There is already a hook for telling the agent about content it can't see.**
  `prompt-composition.ts:99-102` renders a line — *"Attached to this task but NOT available in
  your checkout: …"* — today populated only by documents that didn't fit
  `TASK_DOCUMENTS_BUDGET_BYTES`. The same line is the natural place to name attachments that exist
  but were never indexed, once `materialiseTaskDocuments` is told to look at them.
- **The run-start path is a single synchronous route.** `POST /api/tasks/[taskId]/run`
  (`apps/web/src/app/api/tasks/[taskId]/run/route.ts`) creates the session, the first message, and
  the run, and enqueues it, all in one request with no confirmation step today. This is where a
  staleness check has to sit, because it is the only place "about to run" is a real moment, not an
  inferred one.

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
| 9 | Pull an issue's attachments (filename, mime, size, content) into the task as `task_context_items`, so the agent can see them | Jira → AF | An attachment is often the actual bug report (a screenshot, a log file); without it the agent works from a partial issue |
| 10 | Refresh a linked task from Jira on demand, and check for drift the moment a run starts, prompting the user to update before proceeding | Jira → AF | The task is a point-in-time copy; without a check, an agent can run against a description the reporter has since corrected |
| 11 | Surface a failed write-back with a banner on the task and a signal on the tasks list, not just a `RunEvent` on the transcript | — | "Never fails a run" (capability 5/6) must not mean "never tells anyone" — a silently broken comment defeats the reason the loop exists |

### Out of scope (and why)

- **Creating Jira issues from AgentFactory.** Tasks are the system of record
  (`PRODUCT-DEFINITION.md:55`). Pushing task creation into Jira makes the two systems
  bidirectional, which immediately raises conflict resolution, dedupe, and loop-protection
  questions we have no machinery for. If a team wants a Jira issue, they create it in Jira and
  link it.
- **Continuous status sync.** No polling loop, no webhook, nothing that runs on a schedule or in
  the background. Capability 10 is deliberately *pull, on explicit user action only* (a click on
  Refresh, or a click on Run) — it answers "is this stale right now", it does not keep the task
  current on its own. This is a narrower reading of the same principle, not a reversal of it: the
  write surface is still exactly one moment (PR opened); this adds a *read* check at one other
  moment (about to run) that was previously not checked at all.
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
- **More than one `tasks`-kind connection per org** — a second Jira site, or Jira and Monday at
  once. `resolveTaskProvider` resolves a single connection; supporting more means a connection
  picker on the From-issue field and host-matching disambiguation for write-back and the staleness
  check, none of which exists. Enforced explicitly (Design decision 15) rather than left as a latent
  bug: connecting a second `tasks`-kind connection is a `409`, not a silent misroute.

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
Atlassian outage produces an `error`-type `RunEvent` on the transcript, and the run still reports
`pr_open`. This mirrors how `skills-materialize.ts` degrades (returns `[]` and logs rather than
throwing). A `RunEvent` alone is not the end of the story, though — see Design decision 13: "never
fails the run" is a guarantee about execution, not a license to bury the failure where only someone
who opens the run transcript will find it.

**8. Connection health is written, not decorative.** `connections.health` already exists with
`healthy | needs-attention | expired` and is currently always `healthy`. A 401 from Jira flips it
to `expired`; any other 4xx/5xx flips it to `needs-attention`. This is the first real use of the
column and it gives the Connections page something true to show.

**9. Attachments reuse `task_context_items` unchanged; nothing Jira-specific is added to that
table.** An attachment is, structurally, exactly what `task_context_items` already models: a
titled, content-addressed blob scoped to a task, with a status machine for ingestion. The only gap
is that `source` (`schema.ts:535`, *"Always 'upload' today"*) is hardcoded and not accepted as
repository input — this design adds `source?: string` to `NewTaskContextItem` (default `"upload"`,
unchanged for the existing upload route) so a Jira-derived item can be tagged `source: "jira"`, the
value the column comment already anticipates. No schema change.

**10. Attachment *awareness* does not require attachment *extraction*.** Only `text/markdown` and
`text/plain` attachments go through the existing ingest pipeline and become readable files in the
sandbox — that is what `text-extract.ts` supports today, and extending it to images or PDFs is out
of scope here for the same reason `text-extract.ts`'s own comment gives: each format is "one later,
isolated PR." An attachment of an unsupported mime still gets a `task_context_items` row (so its
existence, filename, and Jira URL are recorded and visible on the task page) and still goes through
`enqueueTaskContextIngestJob`, which — with no code change — already marks it `status: "failed"`
via the existing `UnsupportedMimeError` path. The one real change is in `materialiseTaskDocuments`:
today it silently drops non-`"indexed"` items; this design has it also collect Jira-sourced
`"failed"` items' titles into the existing `omitted` list, so `prompt-composition.ts`'s existing
*"Attached to this task but NOT available in your checkout"* line names them. The agent is told a
screenshot exists and where to see it, even though it cannot read the pixels — meeting "the agent
must be aware of them" without a computer-vision or PDF-parsing project.

**11. Attachment content is fetched at the same moment and by the same code path as the issue
itself — task creation — never re-fetched later.** `GET /api/connections/tasks/issue` already runs
host-side and already decrypts the credential; downloading each attachment's bytes is more calls
on the same authenticated `TaskProvider`, not a new surface. This mirrors Design decision 5 (no
credential in the sandbox) for the same reason: an attachment's Jira `content` URL requires the
same Basic auth header as everything else, so the download cannot happen from inside the sandbox
either.

**12. A staleness check is a read, triggered by the user, and it must never block a run.** Jira's
`fields.updated` timestamp is cheap to compare against a `lastKnownUpdated` value stored on
`Task.externalRef` at creation/refresh time — no diffing, no second table. Two triggers call the
same check: an explicit **Refresh** button on the task page, and an automatic check the instant
**Run** is clicked (`POST /api/tasks/[taskId]/run`). If the check finds drift, the run does not
start; the user is shown what changed and chooses to update-then-run or run-as-is. If the check
*cannot complete* — Jira unreachable, the connection unhealthy, the request times out — the run
proceeds anyway and an event notes the check was skipped. This is Design decision 7's rule applied
to a read instead of a write: a Jira problem must never be why a run couldn't start, exactly as it
must never be why a run is reported failed.

**13. A write-back failure gets a persisted signal, not just a transcript line.** Today, an `error`
`RunEvent` is the only trace of a failed Jira comment — invisible unless a user happens to open that
specific run's transcript. That is not good enough for something that silently breaks the one loop
this integration exists to close. `task-notify.ts`'s existing catch block (Design decision 7) gets
one more write alongside the `RunEvent`: `TaskExternalRef` gains an optional
`writeBackFailure: { message: string; occurredAt: ISODateTime }`, set via the same `updateTask` call
`worker.ts` already makes for `prNumber`/`prUrl`/`status` — no new column, since `tasks.external_ref`
is already `jsonb`. Two things read it:

- The **tasks list** (`apps/web/src/app/(app)/tasks/page.tsx`) shows a small warning indicator next
  to a task's status when `externalRef.writeBackFailure` is set, with the message on hover. No new
  query: `externalRef` already rides along on every `Task` the list already has from
  `useMockBackend()`, so this costs nothing beyond a render-time check per row — it does not become
  an N+1 lookup into `run_events`.
- The **task detail page** shows a banner (reusing `ConfirmationBanner.module.css`, the same styling
  `RepoMapWaitBanner.tsx` already uses, rather than inventing new banner CSS) naming the failure and
  linking out to the Jira issue via `externalRef.url`, with a **Dismiss** action that clears the flag
  through the existing generic `PATCH /api/tasks/[taskId]` route — no new route, since that handler
  already passes its body straight through to `updateTask`.

Not auto-cleared by a retry, because there is no retry: write-back fires at most once per task,
guarded by `result.pushed && !task.prNumber` (Design decision from the "Flow: write-back" ground
truth), so nothing re-attempts it later to naturally clear the flag. A **Retry write-back** action is
real, useful follow-up work — see Follow-ups — but is not required to meet "the user is notified,"
and building it now would mean designing a second write path (and a second set of failure modes)
this spec has not scoped. Dismiss only ever clears the signal; it never re-tries the write.

**14. The "create a task from an issue" field is provider-neutral, even though Jira is the only
adapter that exists.** This is a narrower claim than "build multi-provider support" — it costs
nothing extra today and avoids a rename later. Three things make it free:

- `resolveTaskProvider(orgId)` (Task 4) already resolves "the org's one `kind: "tasks"` connection,
  whatever provider it is" — it was never written to look for `provider === "jira"` specifically,
  because `createTaskProvider` (packages/integrations) already dispatches on `connection.provider`
  internally. The route built on top of it never needed a provider-specific name.
- `connections.find(c => c.kind === "tasks")` and `t(\`connections.provider.${provider}\`)` already
  exist and already work for any provider — `ConnectionsList.tsx` uses exactly this pattern today
  for the connections page itself.
- The one place that *does* have to stay provider-specific is the **connect** flow
  (`POST /api/connections/jira`) — a Jira site needs `siteUrl`/`accountEmail`/`apiToken`; a
  hypothetical Monday connection would need different fields entirely. There is no generic "connect
  a tasks provider" form possible without a plugin-described-fields mechanism this spec is not
  building (Monday/Asana adapters are explicit Follow-ups). So: the connect route and its UI stay
  named for Jira; the *lookup* route (`GET /api/connections/tasks/issue`) and the task-creation
  field's label do not, because looking up an issue never touches provider-specific fields — it only
  calls `parseIssueReference`/`fetchIssue`, both already generic on the `TaskProvider` port.

Concretely: the field is disabled with a `TooltipBubble` ("Connect a task-tracking tool...") when no
`tasks`-kind connection exists, and once one does, its label is generated from that connection's
`provider`, not hardcoded. If Monday ships later as a second `TaskProvider` adapter, this field,
its route, and its disabled-state copy need zero changes — only `createTaskProvider`'s switch
statement and a new connect route gain a case. This is the same reasoning as capability 8's
`connection_secrets` table (built generic because GitHub's app-token model made it obvious Jira
would need something Jira-shaped) applied one layer up, to UI copy and a URL instead of a schema.

**15. At most one `tasks`-kind connection per org — enforced at connect time, not just assumed by
`resolveTaskProvider`.** `resolveTaskProvider(orgId)` (Task 4) already resolves "the *first*
`kind === "tasks"` connection." Nothing in the plan as written stops an org from connecting a
second one — a second Jira site, or (once it exists) both Jira and Monday at once — and if they do,
which connection "first" returns becomes a Postgres implementation detail, not a decision anyone
made. A task created against the second connection could have its write-back, refresh, and
issue-lookup silently routed through the *first* connection's credential instead — wrong site, or
worse, a working call that updates the wrong Jira instance.

The fix is not to build multi-connection support (real work: a connection picker on the From-issue
field, host-matching to disambiguate multiple Jira sites the way `findInstallationForRepo` already
does for GitHub repos, or per-task connection selection) — none of that is justified before there is
a real user who needs two task-tracking connections at once. The fix is to make the single-connection
assumption **true by construction**: `POST /api/connections/jira` checks
`listConnections(orgId)` for an existing `kind: "tasks"` connection before creating a new one, and
returns `409` if one exists, with a message naming the existing connection and telling the user to
disconnect it first. This turns "first" from an accident of query order into the only possibility —
`resolveTaskProvider` was already written as if this were true; this decision makes it actually true.

This is a real, named limitation for v1, not a silent gap — see Out of scope and Risks below. An org
migrating from one Jira site to another, or wanting Jira and Monday simultaneously, hits an explicit
409 with a clear next step (disconnect, then reconnect), not a mysteriously-wrong write-back weeks
later.

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
  /** The provider's own last-modified timestamp as of the last fetch, for the staleness check. */
  lastKnownUpdated: ISODateTime;
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
export interface ExternalAttachment {
  filename: string;
  mime: string;
  sizeBytes: number;
  /** Provider content URL — authenticated, not a public link. Passed back into fetchAttachment. */
  contentUrl: string;
}

export interface ExternalIssue {
  key: string; title: string; description: string;
  status: string; issueType: string; labels: string[]; url: string;
  attachments: ExternalAttachment[];
  /** The provider's own last-modified timestamp — what the staleness check compares against. */
  updated: string;
}
export interface IssueTransition { id: string; name: string; toStatus: string }

export interface TaskProvider {
  /** Verify the credential and return the authenticated account. Called on connect. */
  verify(): Promise<{ accountId: string; displayName: string }>;
  /** Pull out an issue reference from free text; undefined when there isn't one. */
  parseIssueReference(text: string): string | undefined;
  fetchIssue(key: string): Promise<ExternalIssue | undefined>;
  /** Downloads one attachment's bytes, authenticated the same way as every other call. */
  fetchAttachment(attachment: ExternalAttachment): Promise<Uint8Array>;
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
`listConnections(orgId)` checked for an existing `kind: "tasks"` row first (Design decision 15) —
`409` naming it if found, before `verify()` even runs, so a doomed request fails fast and cheap →
`verify()` → on success, `createConnectionSecret(orgId, { apiToken })` →
`createConnection(orgId, { provider: "jira", kind: "tasks", auth: "api_token", credentialRef, config })`.
The token is never echoed back and never read again by the web app; only the worker and the
verify path decrypt it. Delete cascades the secret row — and is how a user replaces one
`tasks`-kind connection with another: disconnect, then connect again.

### Flow: create a task from an issue

The task-creation form has a **From issue** field, disabled by default with a `TooltipBubble`
reading *"Connect a task-tracking tool in Settings → Connections to link an issue"* until
`connections.find(c => c.kind === "tasks")` finds one — no extra fetch, `connections` is already in
`useMockBackend()`'s state. Once a tasks connection exists, the field enables and its label becomes
`t("taskCreate.linkedIssue.fromIssueLabel", { provider: t(\`connections.provider.${conn.provider}\`) })`
— *"From Jira issue"* today, purely because Jira is the only adapter that exists; the label is data,
not a hardcoded string. See Design decision 14 for why this field, unlike the connect flow, costs
nothing to keep provider-neutral even while only one adapter exists.

The user pastes `PROJ-123` or a browse URL, clicks Fetch.
`GET /api/connections/tasks/issue?ref=<text>` resolves the org's one tasks connection (whichever
provider it is), parses the ref, fetches the issue, and returns `ExternalIssue`. The form prefills
title and description and stores `external_ref`. This deliberately mirrors the GitHub issue path
that already exists (`scm-provider.parseIssueReference` + `fetchIssue`), so the interaction is one
users have seen — the mechanism, not the UI, is what's mirrored, since GitHub has no equivalent
fetch-and-prefill widget today (it parses a link out of the Description field at run time instead;
see "Why prefill at creation rather than fetch at run time" below).

Acceptance criteria are *not* auto-extracted from the Jira description in this pass. Jira
descriptions are ADF and teams encode ACs a dozen different ways; guessing wrong is worse than
leaving the existing AC editor empty. Revisit with real customer data.

### Flow: attachments

`fetchIssue` already reads Jira's `fields.attachment[]` in the same response as the rest of the
issue — no second API call to learn *that* attachments exist. For each entry, the same route that
prefills the task form now also, per attachment:

1. `fetchAttachment(attachment)` — a second, authenticated request for the bytes (Jira does not
   inline attachment content in the issue response).
2. `BlobStore.put(orgId, bytes, mime)` → `insertContentBlob` → `createTaskContextItem({ taskId,
   orgId, title: filename, sizeBytes, sha256, mime, source: "jira" })` — the exact sequence
   `context-items/route.ts` already runs for a manual upload.
3. `enqueueTaskContextIngestJob(item.id)` — same queue, same worker, same code path. A
   `text/markdown` or `text/plain` attachment ends up `status: "indexed"` and is written into the
   sandbox by `materialiseTaskDocuments` before the next turn, exactly like a manually uploaded
   doc. Anything else ends up `status: "failed"` via the existing `UnsupportedMimeError`, and is
   surfaced instead by the change in Design decision 10.

An attachment over `MAX_UPLOAD_BYTES` (2 MB, `context-items/route.ts:18`) is skipped with the same
limit, not a special Jira case — `BlobStore.put` has no size opinion, but nothing this design adds
should let a task pull in attachments the manual upload path itself would reject. A task with 40
attachments is plausible for a design-review ticket; this fetch loop runs sequentially and is
bounded by that same per-file cap, not a new "total attachments" limit — see Risks.

### Flow: refresh and the pre-run staleness check

Named `checkTaskSync`, not `checkJiraSync`, for the same reason as Design decision 14: it only ever
calls the generic `resolveTaskProvider(orgId)` + `fetchIssue`, never anything Jira-specific.

Both entry points below resolve to the same function:
`checkTaskSync(orgId, task) => { stale: false } | { stale: true; latest: ExternalIssue }`, which
calls `resolveTaskProvider(orgId)` → `fetchIssue(task.externalRef.key)` and compares
`latest.updated` to `task.externalRef.lastKnownUpdated`. A provider error or a missing connection
returns `{ stale: false }` — see Design decision 12; this check must fail open.

- **Manual refresh.** A **Refresh** action next to the linked-issue badge on the task page calls
  `POST /api/tasks/[taskId]/sync`, which runs `checkTaskSync`. `{ stale: false }` shows "up to
  date." `{ stale: true }` opens a diff view (old vs. new title/description, new attachments listed
  separately since those are additive, not a text diff) with **Update task** / **Dismiss**.
  **Update task** applies `latest`'s fields via the same write path Task 5 already has (`PATCH
  /api/tasks/[taskId]`), re-runs the attachment flow above for any attachment not already present
  (by `sha256`, so a previously-fetched attachment is never re-downloaded), and sets
  `externalRef.lastKnownUpdated = latest.updated`.
- **Pre-run check.** `POST /api/tasks/[taskId]/run` runs `checkTaskSync` before creating the
  session, only when `task.externalRef` is set (any provider — the check itself has no Jira
  branch). `{ stale: false }` (which includes "no linked issue" and "check failed") proceeds
  exactly as today. `{ stale: true }` returns `409 { code: "task_stale", latest }` **without
  creating a session or a run**. The task page's Run
  handler catches that 409 and shows the same diff view, with **Update and run** (calls the sync
  endpoint, then re-POSTs run) and **Run anyway** (re-POSTs run with `{ acknowledgeStale: true }`,
  which skips the check on that one call so the second attempt cannot loop).

This is a UI-level confirmation before a run is enqueued, not an approval gate on a running agent —
`ARCHITECTURE.md`'s "no approval gates" principle governs a run already in flight waiting on a
human; nothing here pauses mid-run, and a user who clicks **Run anyway** gets the same
no-questions-asked execution that exists today.

### Flow: write-back

At `apps/worker/src/worker.ts:418`, immediately after
`updateTask(task.id, { prNumber, prUrl, status: "pr_open" })`:

```
if (task.externalRef?.provider === "jira") → notifyIssueOfPullRequest(orgId, task, pr)
```

which resolves the connection, decrypts the credential, posts a comment linking the PR, and — if
`config.writeBack.transitionTo` is set — transitions the issue. Wrapped so nothing it does can
throw into the run. Emits one `RunEvent` either way, so the transcript records what happened.

On failure, the same catch block also sets `externalRef.writeBackFailure = { message, occurredAt }`
via `updateTask` — the worker already imports and calls `updateTask` on this exact code path, so
this is one more field on an existing write, not a new one.

### Flow: surfacing a write-back failure

`task.externalRef?.writeBackFailure` is read in two places, both purely client-side against data the
page already has:

- **Tasks list.** A small warning glyph next to the status pill, wrapped in a `TooltipBubble`
  (`@agentfactory/shared`) carrying `writeBackFailure.message`. No new fetch — `useMockBackend()`'s
  `tasks` array already contains full `Task` rows including `externalRef`.
- **Task detail page.** A banner above the conversation thread — visually the same
  `confirmationStyles.banner`/`.title`/`.body` classes `RepoMapWaitBanner.tsx` uses, so this is a
  third user of an existing pattern, not a new one — showing the message, a link to the issue
  (`externalRef.url`), and a **Dismiss** button. Dismiss calls the existing
  `PATCH /api/tasks/[taskId]` route with `{ externalRef: { ...task.externalRef, writeBackFailure: undefined } }`;
  that route already forwards its body to `updateTask` unmodified, so no route change is needed —
  only the client-side call.

This deliberately does not use the transcript's `ErrorNotice` mechanism
(`apps/web/src/lib/run-errors.ts`) — that path renders inline, per-run, keyed to whichever message
produced the run, and a write-back failure is not part of the conversation the agent had; it is a
fact about the task's link to its external issue, which is why it belongs beside the linked-issue
badge and on the list row instead.

### UI

All connection UI lives in `apps/web/src/components/ConnectionsList.tsx` (rendered by
`SettingsView`; `/connections` is only a redirect shim). It gains:

- A **Connect Jira** action beside the existing hardcoded **Connect GitHub** button, opening a
  modal (site URL, email, API token). The button pair should become a small provider-driven list
  rather than two hardcoded buttons, so Slack/Monday do not each add another branch. This one stays
  Jira-named on purpose — see Design decision 14 on why the connect flow can't be made generic for
  free the way the issue-lookup flow below can.
- A per-connection **Configure** panel, shown only for `kind: "tasks"`, carrying the write-back
  toggles; the transition target is populated from `listTransitions` against a sample issue key
  the user supplies, so the user picks a name rather than typing a numeric id.
- The task creation form gains a **From issue** input — disabled with a tooltip until a tasks
  connection exists, then labeled with that connection's provider (Design decision 14). The task
  detail page shows a linked-issue badge, labeled the same way, linking to `external_ref.url`
  beside the existing PR link.

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
  and does not throw; a task with no `external_ref` is a no-op. `materialiseTaskDocuments` also
  lists a Jira-sourced `"failed"` item's title in `omitted`, and still ignores a non-Jira `"failed"`
  item's title today's behaviour depended on (none exist yet, but the filter must be additive, not
  a broadening that changes existing callers). A provider error also sets
  `externalRef.writeBackFailure`, and a *successful* write-back leaves it unset (so a task's first
  write-back never shows a stale failure it never had).
- **Unit/component, `apps/web`** — the tasks list renders the warning indicator only when
  `externalRef.writeBackFailure` is set, and its tooltip shows the stored message; the task detail
  banner renders the message and the Jira link, and Dismiss issues a `PATCH` that omits
  `writeBackFailure` from the returned task and removes the banner without a page reload.
- **Unit, `packages/integrations`** — `fetchIssue` maps `fields.attachment[]` to
  `ExternalAttachment[]` and `fields.updated` to `updated`; `fetchAttachment` sends the same auth
  header as every other call and returns raw bytes.
- **Integration, `apps/web`** — the attachment loop in the issue-fetch route: a markdown attachment
  ends up `status: "indexed"`; a PNG ends up `status: "failed"` with a `task_context_items` row
  still present; an attachment over `MAX_UPLOAD_BYTES` is skipped and not stored; fetching the same
  issue twice does not duplicate an already-stored attachment (the existing `(task_id, sha256)`
  unique constraint rejects it, `onConflictDoNothing` making this a no-op, not an error).
- **Unit, `apps/web`** — `checkTaskSync`: identical `updated` → not stale; a newer `updated` →
  stale with `latest` populated; `fetchIssue` throwing → not stale (fails open); a task with no
  `external_ref` → not stale without calling the provider; the field-disabled state on the
  task-creation form when `connections.find(c => c.kind === "tasks")` is undefined, and its label
  once one exists.
- **Route, `apps/web`** — `POST /api/tasks/[taskId]/run` returns `409 { code: "task_stale" }` and
  creates no session/run when stale; `{ acknowledgeStale: true }` bypasses the check and behaves as
  today; a task with no linked issue is never delayed by a provider call at all.
- **Route, `apps/web`** — `POST /api/connections/jira` returns `409` and creates neither a
  connection nor a secret when the org already has a `kind: "tasks"` connection — checked *before*
  `verify()` is called, so the test can assert the stubbed Jira `myself` endpoint is never hit for
  this case. After deleting the existing connection, a second `POST /api/connections/jira` succeeds
  normally.
- **E2E, `apps/web`** — connect flow against a stubbed Jira, with an assertion that the API token
  never appears in any response body; create-task-from-issue against a fixture with one markdown
  and one image attachment, asserting both appear on the task page and only one is marked
  available; a stale-then-run scenario against a stubbed Jira that changes `fields.updated` between
  task creation and the Run click.

## PR sequence

| # | PR | Contents | Demoable |
|---|---|---|---|
| 1 | Schema + core types | `connection_secrets` table, `connections.auth`/`credential_ref`, `tasks.external_ref` (+ `lastKnownUpdated`), migration, `ConnectionAuthKind`/`TaskExternalRef`, `updateConnection` + a health writer | No — no behaviour change |
| 2 | Credential storage | AES-256-GCM helpers in `packages/db`, `connection-secrets` repository, unit + integration tests | No |
| 3 | The port + the adapter | `packages/integrations`: `TaskProvider`, `createTaskProvider`, `JiraTaskProvider`, ADF→Markdown, recorded fixtures | No — but the adapter is fully unit-tested |
| 4 | Connect Jira | `POST /api/connections/jira`, single-tasks-connection enforcement, verify-on-save, secret cascade on delete, Connections UI + i18n | **Yes** — a Jira site appears on the Connections page; a second connect attempt is rejected |
| 5 | Task ← issue + attachments | `GET /api/connections/tasks/issue` (provider-neutral route, currently only resolves Jira), disabled/labeled From-issue field, `external_ref` persisted, attachment fetch loop into `task_context_items`, linked-issue badge + attachment list on task detail | **Yes** — paste `PROJ-123`, get a filled-in task with its attachments listed |
| 6 | Write-back + failure signal | `notifyIssueOfPullRequest` at the `worker.ts:418` hook point, config panel for comment/transition toggles, `TaskExternalRef.writeBackFailure`, the tasks-list indicator and task-detail banner/Dismiss | **Yes** — run an agent, watch the Jira issue get a PR comment; revoke the token and watch the banner and list indicator appear instead |
| 7 | Refresh + staleness check | `POST /api/tasks/[taskId]/sync`, diff UI, the pre-run check wired into `POST /api/tasks/[taskId]/run`, `materialiseTaskDocuments`'s `omitted`-list extension | **Yes** — edit a linked issue in Jira, click Run, see the prompt before it runs stale |

1–3 are independently mergeable and invisible to users; each can land while the next is in review.
4 makes Jira connectable, 5 makes it useful, 6 closes the loop, 7 keeps it honest.

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
- **A failed write-back has no retry, only Dismiss.** Write-back fires at most once per task, so
  once it fails, the only paths forward are a human manually commenting on the Jira issue, or a
  follow-up **Retry write-back** action this spec does not build (see Follow-ups). Dismiss silences
  the signal; it does not fix anything. Worth watching once this ships — if failures turn out to be
  common (expired tokens are the likely case), the fix is that retry action, not a change to this
  design.
- **Attachment fetch is sequential and un-cached across a slow connect.** A large attachment set
  makes task creation from a Jira issue slower than from a GitHub link, which fetches no
  attachments at all today. If this proves annoying in practice, the fix is to return the task
  immediately and ingest attachments as a background job (the queue already exists), not to make
  attachments synchronous forever — not needed to ship v1, called out so it isn't a surprise.
- **The pre-run check adds one Jira round trip to every run of a linked task.** Fails open (Design
  decision 12), so a slow or down Jira degrades run-start latency, not run-start success — worth
  watching once this ships, since "every run of a linked task" is a much hotter path than "once per
  task, at PR open."
- **At most one `tasks`-kind connection per org (Design decision 15).** An org that genuinely needs
  two — migrating between Jira sites, or running Jira and Monday side by side — hits a `409` on the
  second connect attempt with no workaround except disconnecting the first. This is a deliberate v1
  cut, not an oversight, but it is the first capability this plan actively takes away rather than
  simply not building yet. If it proves too restrictive, the fix is real multi-connection support
  (a picker on the From-issue field, host-matching disambiguation), not a config flag — there is no
  cheap partial version of "which of two connections did this task mean."

These are genuinely product calls, not engineering ones, and the issue explicitly asks for them
to be settled first:

1. **API token before OAuth 2.0 3LO** — accepted risk of an account-scoped credential in exchange
   for shipping weeks earlier?
2. **No issue creation, no continuous sync** — is "AgentFactory is the system of record, Jira is a
   linked upstream" the right product stance, or do users expect tasks to appear in Jira?
3. **Transition-on-PR-open, configured per connection** — or is transitioning too opinionated to
   do automatically at all, leaving only the comment?
4. **Cloud only** — is there a known Data Center user we would be excluding?
