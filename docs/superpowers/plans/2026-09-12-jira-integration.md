# Jira Integration — plan

**Date:** 2026-09-12
**Status:** proposed
**Issue:** or-borco/AgentFactory#169

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Only Phase 1–3 are broken into checkbox steps; Phase 4 is deliberately left as a scope statement, not instructions, because it depends on shared infrastructure (a trigger bus, MCP wiring) that doesn't exist for *any* provider yet — see "Future phases" below for why.

## Problem

Jira is already threaded through the domain model as a placeholder, but none of it is backed by real code:

- `ConnectionProvider` includes `"jira"` and `ConnectionKind` includes `"tasks"` (`packages/core/src/domain.ts:141-146`).
- `TriggerSource` includes `"jira"` (`domain.ts:197`) — but no `triggers` table exists anywhere in `packages/db/src/schema.ts`. The `Trigger` type is pure aspiration today; grepping the whole repo for it turns up only the type definition and an unrelated `Run.triggeringMessageId` field.
- `SessionOrigin` includes `"jira"` and `sessionOriginEnum` in `schema.ts:162` already lists it — nothing ever writes it.
- The Team shared-context mock inventory (`apps/web/src/lib/shared-context.ts:193-197`) already describes the intended shape: *"Jira — API token auth; agents can create/update issues and link to runs"* — but this is display-only mock data, not a real connection.

Meanwhile GitHub — the one connection that *is* real — is a complete, working reference implementation: an App-install connect flow (`apps/web/src/app/api/connections/github/{start,callback}/route.ts`), a per-org installation-token minting layer (`apps/web/src/server/github-app.ts`, duplicated intentionally into `apps/worker/src/scm-provider.ts`), and a task-description-to-issue-content pull-in (`parseIssueReference` + `fetchIssue`, wired into `apps/worker/src/worker.ts:222-232`). Jira needs the equivalent of all three, adapted for a fundamentally different auth model (see Design decisions below).

This issue's own notes ask to flesh out exact requirements before writing code — that's what this document does.

## Ground truth this plan relies on

- `packages/db/src/schema.ts:140-144`: `connections.provider` is stored as plain `text`, not a Postgres enum, specifically so new providers (the comment names `jira` explicitly) never need a schema migration to be added. Only `kind`/`health` are enums.
- `connections.config` is `jsonb`, and its only documented shape today is GitHub's `{ installationId, accountLogin, accountType }` — "No token/secret lives here — installation tokens are minted on demand from the platform's GitHub App private key... never persisted" (`schema.ts:155-157`). **Jira breaks this assumption**: there is no "platform private key that mints free per-org tokens" equivalent for Jira Cloud API tokens — a real per-connection secret has to be persisted. This is the one genuinely new piece of infrastructure this plan needs that GitHub's implementation never had to solve.
- ARCHITECTURE.md §5 classifies task systems (Jira/Monday/Asana/Sheets) as *"both a trigger source and a tool. Exposed to the agent as MCP servers; their webhooks feed the trigger bus"* — and assigns this to **M5 ("Automation")**, after M2 (GitHub/coding agents), M3 (context), M4 (Slack). Jira-as-trigger and Jira-as-agent-tool are explicitly the last integration work in the architecture's own build order, gated on a trigger bus and MCP wiring that don't exist for any provider today.
- ARCHITECTURE.md §6's blast-radius table already specifies the allowed/never split for task systems: **allowed** — "Read tickets, comment, move to a review column"; **never** — "Delete tickets, close issues, change permissions or assignees outside its scope." This plan's action list (below) follows that split exactly.
- `apps/web/src/server/github-app.ts` + `apps/worker/src/scm-provider.ts` are deliberately duplicated across the two processes rather than shared ("apps/worker and apps/web are separate processes/packages with no shared-code path between them today" — `scm-provider.ts:28-30`). The Jira equivalent follows the same split.
- `worker.ts:222-232` already runs `parseIssueReference`/`fetchIssue` **before** the turn, on the worker host — never inside the sandbox, because "the sandbox has no GitHub credentials or HTTP client, by design." The Jira read path follows the identical shape.
- `Task` (`domain.ts`) already carries `prNumber?`/`prUrl?` for GitHub PR linking — the direct precedent for adding `jiraIssueKey?`/`jiraIssueUrl?`.
- No MCP server wiring exists anywhere in `apps/worker` yet (confirmed by the Skills feature design spec's own ground-truth read of `run-turn.ts`, and independently confirmed here) — so "Jira as an agent-invokable tool" cannot land before that infrastructure does, regardless of this plan.
- No credential vault exists (`connections` has no secret column at all today; GitHub never needed one).

## Goal

Add Jira as a real, working `tasks`-kind Connection, in the same incremental, demoable-per-slice style the rest of this codebase ships in:

1. An org can connect a Jira Cloud site with an API token, validated at connect time.
2. A task description containing a Jira issue link gets that issue's content pulled into the run's prompt, exactly like a GitHub issue link does today.
3. A task can be explicitly linked to a Jira issue (create one, or attach an existing key), with the link surfaced on the task page.
4. Jira-specific types never reach `packages/core` or the DB layer beyond `Connection.config`/a new credential column — all Jira API shapes live behind a `JiraProvider` adapter, mirroring the `ScmProvider` pattern.

Explicitly **not** goals of this plan (see "Future phases"): Jira as a trigger source, agent-invokable Jira tools mid-run, OAuth 2.0 (3LO).

## Exact Jira actions in scope

**Read**
- Get issue by key (summary, description, status, assignee, comments) — powers the task-description pull-in and the task-linking UI.

**Write**
- Create issue (project, issue type, summary, description) — "file a ticket from a task."
- Add comment — status reporting back to the ticket, mirrors GitHub PR comments.
- Transition issue via a transition *id* resolved from the site's own workflow (never a raw free-text status) — matches ARCHITECTURE §6's "move to a review column."
- List available transitions for an issue — needed to populate the transition action safely (can't transition to an id that isn't a legal next state).

**Explicitly never** (per ARCHITECTURE §6, same rule as every other integration):
- Delete issues.
- Change permissions, issue security, or reassign outside the connecting org's own scope.
- Bulk/cross-project operations, arbitrary JQL execution exposed to the agent.

All of the above are called from `apps/web` or `apps/worker` server-side code in this plan — **none of them are agent-invokable tools yet** (see Design decisions).

## Design decisions

- **Auth: Jira Cloud API token (email + token, HTTP Basic), not OAuth 2.0 (3LO).** Matches the intent already written into the shared-context mock copy, needs no user-facing consent screen, and is the fastest path to a working `JiraProvider` that proves the pattern. 3LO (multi-user consent, finer per-user scopes) is real future work, not required for an org-level connection — `Connection` is already org-wide, same granularity GitHub uses.
- **A real secret has to be persisted, unlike GitHub.** New `connections.credential` column (nullable `text`), written/read only by the connections repository, encrypted at rest with an app-level symmetric key (AES-256-GCM) from a new `JIRA_CREDENTIAL_KEY` env var — same operational shape as `GITHUB_APP_PRIVATE_KEY`, but this is the platform's first stored *customer* secret rather than its own app identity, so it gets its own short security review before shipping. `toConnection()` (`packages/db/src/repositories/connections.ts`) never includes this column in what it returns — the API/UI layer must never see a decrypted or even ciphertext credential. This is a pragmatic stopgap; ARCHITECTURE §5's "credential lives in the vault, only a reference here" is the real target and should replace this column before onboarding untrusted/enterprise customers.
- **New port: `JiraProvider`**, following the exact `ScmProvider` split — `apps/worker/src/jira-provider.ts` (worker-side: read pull-in, and any write actions a task-page route delegates to the worker) and a thin `apps/web/src/server/jira.ts` (web-side: connect-time validation, task-page write actions that don't need a sandbox). Every function takes an already-resolved `{ siteUrl, email, apiToken }`, never a bare `orgId` — mirrors how `cloneIntoSandbox` takes a resolved `CloneTarget` rather than re-deriving one per call.
- **No MCP exposure, no agent-invokable Jira tools, in this plan.** ARCHITECTURE §5 puts Jira-as-tool behind MCP wiring that doesn't exist for anything today. Until it does, every write action here is only reachable through an explicit, human-initiated task-page button — never something the agent can call mid-run. This keeps the "every action reversible, no prompt-injection-triggered writes" property intact without needing `ToolPolicy`/`PolicyEngine` to have a Jira-specific rule yet. When MCP wiring lands (for any provider), Jira's write actions become ordinary `ToolPolicy.rules` entries (e.g. `"jira.transition"`) — no new mechanism, just new rule names.
- **Health check at connect time.** `GET /rest/api/3/myself` with the supplied credential before creating the `Connection` row — mirrors `getInstallation`'s role in the GitHub callback. A bad token is caught at connect time, not discovered on first real use, matching ARCHITECTURE §9's "an expired BYO key fails every run silently" concern.
- **Task linking mirrors PR linking.** `Task.jiraIssueKey?: string` / `Task.jiraIssueUrl?: string`, set either by parsing an issue link out of the description (read-only display, no write) or by an explicit "Create Jira issue" task action that calls `createIssue` and stores the result — same shape as `prNumber`/`prUrl` getting set once a draft PR opens.
- **Multi-site orgs get one `Connection` row per Jira site.** `parseJiraIssueReference` has to pick the right connection by matching the issue URL's host against each Jira connection's `config.siteUrl`, mirroring `findInstallationForRepo`'s loop over an org's GitHub connections.
- **No background sync.** Once a task is linked, nothing polls Jira to keep status in sync in either direction — every action is explicit and human/agent-triggered. Staleness (e.g. the Jira issue is deleted or transitioned externally) is an accepted v1 limitation, not solved here.

## Mechanism

### Schema (`packages/db/src/schema.ts`)
```ts
// connections: new nullable column, written/read only by packages/db/src/repositories/connections.ts.
// AES-256-GCM ciphertext (iv + tag + data), keyed by JIRA_CREDENTIAL_KEY. Never selected into
// the shape toConnection() returns.
credential: text("credential"),
```
```ts
// tasks: mirrors pr_number / pr_url exactly.
jiraIssueKey: text("jira_issue_key"),
jiraIssueUrl: text("jira_issue_url"),
```

### Core types (`packages/core/src/domain.ts`)
```ts
export interface Task {
  // ...existing fields...
  jiraIssueKey?: string;
  jiraIssueUrl?: string;
}
```
No change to `Connection` — `config: Record<string, unknown>` already covers `{ siteUrl, email }`; the secret itself lives in the new column, never in `config`, never in the `Connection` type surfaced to the API/UI.

### Repository (`packages/db/src/repositories/connections.ts`)
- `createConnection` gains an optional `credential?: string` input, encrypted before insert.
- New `getConnectionCredential(id): Promise<string | undefined>` — the *only* function allowed to decrypt; called exclusively from `jira-provider.ts`/`server/jira.ts`, never from a route handler that serializes to JSON.

### API (`apps/web/src/app/api`)
- `POST /api/connections/jira` — body `{ siteUrl, email, apiToken }`. Calls the `myself` health check; on success, encrypts and stores, creates `Connection(provider:"jira", kind:"tasks", config:{siteUrl,email})`; on failure, `400` with the Jira error surfaced.
- `DELETE /api/connections/[connectionId]` — already generic, works unchanged (deletes the row, credential included).
- `POST /api/tasks/[taskId]/jira-issue` — creates a Jira issue from the task's title/description via `server/jira.ts`, stores `jiraIssueKey`/`jiraIssueUrl` on the task.

### Worker (`apps/worker/src`)
- `jira-provider.ts` (new): `parseJiraIssueReference(text)`, `getIssue(credentialed, issueKey)`, `createIssue(...)`, `addComment(...)`, `listTransitions(...)`, `transitionIssue(...)`.
- `worker.ts`: alongside the existing `parseIssueReference(task?.description)` / `fetchIssue` call (`worker.ts:226-232`), add the Jira equivalent — both run independently since a task may reference either, neither, or (rare) both.

### UI (`apps/web/src`)
- `components/ConnectionsList.tsx` — new "Connect Jira" button opening a small modal (`siteUrl` / `email` / `apiToken` fields) — unlike GitHub's App-install redirect, this is a direct form `POST`, no redirect round-trip.
- Task detail page — if `jiraIssueKey` is set, show it as a linked badge (key + external-link icon, `jiraIssueUrl` as the href); if not, a "Create Jira issue" button (only rendered when the org has a healthy Jira connection).
- `en.ts` — new `connections.provider.jira` (may already resolve via the generic `connections.provider.*` pattern — confirm before adding), `connections.connectJira`, `taskDetail.jira.*` keys.

## Testing

- **DB integration** (`packages/db/src/__tests__/repositories/connections.test.ts`): credential round-trips through encrypt/decrypt correctly; `listConnections`/`getConnection` never include the raw or encrypted credential in their returned shape.
- **Worker unit** (`apps/worker/src/__tests__/jira-provider.test.ts`, mocked `fetch` — matches `scm-provider.test.ts`'s pattern): `parseJiraIssueReference` matches a real Jira Cloud issue URL and rejects non-matching text; `getIssue`/`createIssue`/`addComment`/`transitionIssue` send the expected request shape and auth header, and surface a clear error on a non-OK response; multi-connection host matching picks the right site.
- **Route handler tests**: `POST /api/connections/jira` rejects an invalid token (myself-check failure) with `400` and creates nothing; a valid token creates exactly one `Connection` row with no plaintext credential in the response body.
- **Manual/E2E**: connect a real (or sandboxed test) Jira Cloud site, create a task whose description contains an issue link, confirm the issue's summary/description shows up in the run's composed prompt (via the existing run-prompt viewer); use the task-page "Create Jira issue" action and confirm the issue appears in Jira with the task's content.

## Suggested build order (PRs)

| # | PR | Contents | Demoable |
|---|---|---|---|
| 1 | Schema + credential encryption | `connections.credential` column + encrypt/decrypt helper, `tasks.jira_issue_key`/`jira_issue_url` columns, migration, `JIRA_CREDENTIAL_KEY` env doc | No |
| 2 | Connect flow | `POST /api/connections/jira`, `myself` health check, `ConnectionsList` "Connect Jira" modal | Yes — connect a real Jira Cloud site, see it listed under Connections |
| 3 | Issue pull-in | `jira-provider.ts` (`parseJiraIssueReference` + `getIssue`), wired into `worker.ts` prompt composition | Yes — a task description with a Jira link pulls issue content into the run's prompt |
| 4 | Task↔issue linking | `createIssue`/`addComment`/`listTransitions`/`transitionIssue`, `POST /api/tasks/[taskId]/jira-issue`, task-page UI | Yes — file or link a Jira issue from a task, comment/transition it from the task page |

Each PR is independently reviewable and ships working behavior on its own, matching this repo's existing PR-sequencing convention (see `docs/superpowers/specs/2026-09-10-skills-feature-design.md`'s own PR table).

## Future phases (explicitly out of scope here)

- **Jira as a trigger source / `automatic` mode.** Needs a `triggers` table and a generic inbound webhook bus (`POST /webhooks/:provider` → verify → normalize → match `triggers` → enqueue a Run) per ARCHITECTURE §5. This is shared infrastructure no provider has today — not a Jira-specific gap — and is explicitly ARCHITECTURE's M5. Building it just for Jira would mean redoing it for Slack/GitHub triggers later; it belongs to its own plan.
- **Jira exposed as an agent-invokable MCP tool.** Needs worker-side MCP server wiring that doesn't exist for any provider yet. Once it lands, Jira's write actions slot into `ToolPolicy` as ordinary deny-by-default rules — no new mechanism, just new rule names.
- **OAuth 2.0 (3LO).** Real work if/when per-user Jira identity or finer read/write scoping is needed; the API-token model in this plan is intentionally the smaller, faster v1.
- **A real secrets vault** to replace the app-level-encrypted `connections.credential` column, before handling enterprise/BYO Jira credentials at scale.
- **Monday/Asana/Google Sheets** — other `tasks`-kind providers. The `JiraProvider` port is shaped so a second adapter should be roughly as mechanical as `ClaudeCodeRuntime` → a second `AgentRuntime` is meant to prove (ARCHITECTURE §0/§8, M6).

## Open questions / risks

- Where `JIRA_CREDENTIAL_KEY` is minted/rotated is an ops decision, not a code one — flag before Phase 1 merges.
- Multi-site orgs (two Jira connections) need the host-matching disambiguation described above; if that proves fragile in practice, an explicit "which Jira site" picker on the task page is the fallback.
- No staleness detection if a linked issue is later deleted or transitioned outside AgentFactory — acceptable for v1, worth a health indicator later if it causes confusion.
