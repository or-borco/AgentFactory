# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
pnpm install

# Run the web app in dev mode
pnpm dev
# or directly:
pnpm --filter @agentfactory/web dev

# Run the worker in dev mode (consumes the BullMQ `runs` queue)
pnpm dev:worker

# Run web + worker together
pnpm dev:all

# Build all packages
pnpm build

# Type-check all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Tests
pnpm test:unit    # vitest --project unit — no external services needed
pnpm test:db      # vitest --project db-integration — needs Postgres
pnpm test:queue   # vitest --project queue-integration — needs Redis
pnpm test:e2e     # Playwright, apps/web
pnpm test         # all of the above, in that order
```

## Monorepo Structure

This is a pnpm workspace monorepo:

- **`packages/core`** — shared domain types (`domain.ts`) and the `RunEvent` union (`events.ts`). This is the single source of truth for all entity shapes; both `apps/web` and `apps/worker` import from here. Never duplicate these types elsewhere.
- **`packages/db`** — the real Postgres store (Drizzle): schema (`schema.ts`) and repositories for orgs/users/teams/agents/sessions/runs/events, skills, connections + `connection_secrets` (encrypted vault), tasks, and the context-retrieval tables. See [ARCHITECTURE.md](ARCHITECTURE.md) §2.7 for the full table list and what's deliberately not built yet (`triggers`, `policy_decisions`, `usage_records`, `audit_log`).
- **`packages/queue`** — BullMQ setup shared between `apps/web` (enqueue) and `apps/worker` (consume).
- **`packages/storage`** — the `content_blobs` blob store (local filesystem in dev, S3 in prod).
- **`packages/integrations`** — the `TaskProvider` port and the `JiraTaskProvider` adapter (direct REST, not MCP — see ARCHITECTURE.md §9).
- **`packages/shared`** — reusable UI primitives (Button, Card, Badge, TextInput, etc.) built with Tailwind. No business logic.
- **`apps/web`** — Next.js 16 App Router frontend + Route Handlers that call `packages/db` directly. This is the real backend, not a mock.
- **`apps/worker`** — a BullMQ consumer that provisions a Docker sandbox per session (`DockerSandboxProvider`), clones the repo, runs the Claude Agent SDK inside the container, and streams `RunEvent`s back through Postgres/Redis.

## Current State

Most of the stack is real, not mocked: Postgres/Drizzle, a working `apps/worker` that runs agents inside Docker
sandboxes, real GitHub App + Jira integrations, real skills, and a real context-retrieval (RAG) pipeline. See
ARCHITECTURE.md's status header for the full picture.

**What's still missing matters for anything touching runs or tool access**: there is no policy engine gating tool
calls — the sandbox currently runs the SDK with `permissionMode: "bypassPermissions"` and full, unrestricted tool
access — no budget/cost enforcement, and no `resolveCredentials` (the platform Anthropic key is read straight from
`process.env` in `apps/worker/src/agent-runtime.ts`). Don't assume a `PolicyEngine`, budget caps, or credential
resolution exist anywhere in the code just because `agents.toolPolicy` is a schema column — see ARCHITECTURE.md §6.

**Client data access:** `apps/web/src/lib/app-data/context.tsx` exports `AppDataProvider` and `useAppData()` —
renamed from `MockBackendProvider`/`useMockBackend()` now that the original UI-mock phase is fully gone (there's no
`mock-store.ts` left; `apps/web/src/server/mock-store.ts` no longer exists in the codebase). Data flow today:
`packages/db` → `apps/web/src/app/api/**/route.ts` Route Handler → `apiFetch<T>()`
(`apps/web/src/lib/api-client.ts`) → `AppDataProvider` → `useAppData()` hook → component.

## Routing

Uses Next.js App Router route groups:

- `(auth)` — `/login`, `/register`, `/forgot-password`. No shared layout beyond the root.
- `(app)` — all authenticated routes. Layout wraps children in `<LeftPane>` (the sidebar nav).
- `app/api/` — Route Handlers for the real backend, calling into `packages/db`.

## i18n

All user-facing strings go through `useTranslation()` from `@/lib/i18n/context`. The `t()` function is typed against the English dictionary (`en.ts`) via the `TranslationKey` type in `paths.ts` — misspelled keys are a compile error. Add new strings to `en.ts` first; the type updates automatically.

## Domain Model

The core entities (from `packages/core/src/domain.ts`) are:

- **Org** → **Team** → **Agent** — the tenant hierarchy. Every entity carries `orgId`.
- **Agent** has a `mode` (`manual` | `automatic`), a `toolPolicy` (deny-by-default with per-tool overrides), `skillIds`, and `connectionIds`.
- **Session** has many **Runs**; a Run has many **RunEvents** (the append-only event log that is the source of truth for transcripts).
- **Skill** is versioned (`SkillVersion`); `agent_skills` pins a `skillVersionId` not a `skillId` — upgrades are explicit. Real and shipped.
- **Connection** covers three kinds: `scm` (GitHub — real, a GitHub App), `channel` (Slack/Discord/… — not implemented, no `ChannelAdapter` exists yet), `tasks` (Jira — real, via a direct REST `TaskProvider` adapter in `packages/integrations`, not MCP; Monday/Asana/Sheets not implemented).

## Architecture Principles (from ARCHITECTURE.md)

Read ARCHITECTURE.md before making structural decisions. Key constraints — note the first two are the **target
design, not current behavior** (ARCHITECTURE.md §1, §6 have the gap in detail; don't grep for `PolicyEngine` or a
literal `AgentRuntime` class expecting to find one):

- **The backend must be agnostic to the agent SDK.** Everything agent-execution-related is meant to go behind an `AgentRuntime` port interface, with `ClaudeCodeRuntime` as the first adapter. **Not built yet** — `apps/worker/src/agent-runtime.ts` calls the Claude Agent SDK directly (inside the sandbox); there is no `AgentRuntime` interface or adapter class. What *is* real is `SandboxProvider` (`DockerSandboxProvider`). Never let provider types reach the DB or API layer regardless.
- **No approval gates.** Runs are never paused waiting for human input — this part holds. But the intended enforcement mechanism, where authorization is decided at config time via `ToolPolicy` and a `PolicyEngine` answers synchronously and emits a `policy_decision` event for audit, **does not exist**. The sandbox currently runs with `permissionMode: "bypassPermissions"` and unrestricted tool access.
- **Run state lives in Postgres, never in closures.** The explicit state machine (`queued → provisioning → running → finalizing → done | failed | cancelled`) on `runs.status` is what will make a future Temporal migration mechanical. Real.
- **`shared_context` is always injected; `context_items` are retrieved on demand.** The 64 KB cap on `teams.sharedContext` is enforced both at the API layer and as a constraint — it exists because this text goes into every prompt. Real, and the retrieval pipeline (`team_context_items`/`context_chunks`, plus a task-scoped equivalent) is fully built with pgvector.
- **Content-addressed storage.** Blobs are addressed by SHA-256 via `content_blobs` (local filesystem in dev, S3 in prod through `packages/storage`). Postgres holds what you query, join, or inject into a prompt. Real.

## Code Comments

Do not use code comments in this repo. Write code and identifiers clear enough that comments aren't needed.

## `packages/shared` Components

These are plain Tailwind components (no shadcn dependency yet). Use them for all new UI:
`Button` (variant primary/secondary), `Card`, `CardLink`, `Badge`, `TextInput`, `Textarea`, `PageHeader`, `Breadcrumb`, `TooltipBubble`, `Truncate`, `EmptyState`.
