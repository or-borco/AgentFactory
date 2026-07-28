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

# Build all packages
pnpm build

# Type-check all packages
pnpm typecheck

# Lint all packages
pnpm lint
```

There are no tests yet (the test suite is planned per ARCHITECTURE.md milestones).

## Monorepo Structure

This is a pnpm workspace monorepo:

- **`packages/core`** — shared domain types (`domain.ts`) and the `RunEvent` union (`events.ts`). This is the single source of truth for all entity shapes; both the web app and the future worker import from here. Never duplicate these types elsewhere.
- **`packages/shared`** — reusable UI primitives (Button, Card, Badge, TextInput, etc.) built with Tailwind. No business logic.
- **`apps/web`** — Next.js 16 App Router frontend + mock API. The only runnable app right now.

## Current State: UI Mock Phase

The app is in **M0** (foundation scaffolding per ARCHITECTURE.md). There is no real backend, no database, and no agent execution. The architecture document describes the full planned system; the running code is a UI mock.

**How the mock works:**

1. `apps/web/src/server/mock-store.ts` — a server-only in-memory store initialized from seed data. Resets on dev server restart. This stands in for the database.
2. `apps/web/src/app/api/**/route.ts` — Next.js Route Handlers that read/write the mock store. These are the "backend" for now.
3. `apps/web/src/lib/mock/context.tsx` — `MockBackendProvider` and `useMockBackend()` hook that client components use for all data access. It fetches from the API routes on mount and keeps a React-state cache.
4. `apps/web/src/lib/api-client.ts` — `apiFetch<T>()` is the single call site for all client→API communication. If the mock API is ever replaced by a real service, this is the only file that changes.

Client components never import from `mock-store.ts` directly (it's server-only). Data flows: mock-store → API route → `apiFetch` → `MockBackendProvider` → `useMockBackend()` hook → component.

## Routing

Uses Next.js App Router route groups:

- `(auth)` — `/login`, `/register`, `/forgot-password`. No shared layout beyond the root.
- `(app)` — all authenticated routes. Layout wraps children in `<LeftPane>` (the sidebar nav).
- `app/api/` — Route Handlers for the mock backend.

## i18n

All user-facing strings go through `useTranslation()` from `@/lib/i18n/context`. The `t()` function is typed against the English dictionary (`en.ts`) via the `TranslationKey` type in `paths.ts` — misspelled keys are a compile error. Add new strings to `en.ts` first; the type updates automatically.

## Domain Model

The core entities (from `packages/core/src/domain.ts`) are:

- **Org** → **Team** → **Agent** — the tenant hierarchy. Every entity carries `orgId`.
- **Agent** has a `mode` (`manual` | `automatic`), a `toolPolicy` (deny-by-default with per-tool overrides), `skillIds`, and `connectionIds`.
- **Session** has many **Runs**; a Run has many **RunEvents** (the append-only event log that is the source of truth for transcripts).
- **Skill** is versioned (`SkillVersion`); `agent_skills` pins a `skillVersionId` not a `skillId` — upgrades are explicit.
- **Connection** covers three kinds: `scm` (GitHub), `channel` (Slack/Discord/…), `tasks` (Jira/Monday/…).

## Architecture Principles (from ARCHITECTURE.md)

Read ARCHITECTURE.md before making structural decisions. Key constraints:

- **The backend must be agnostic to the agent SDK.** Everything agent-execution-related goes behind the `AgentRuntime` port interface. The first adapter is `ClaudeCodeRuntime`. Never let provider types reach the DB or API layer.
- **No approval gates.** Runs are never paused waiting for human input. Authorization is decided at config time via `ToolPolicy`; the `PolicyEngine` answers synchronously and emits a `policy_decision` event for audit.
- **Run state lives in Postgres, never in closures.** The explicit state machine (`queued → provisioning → running → finalizing → done | failed | cancelled`) on `runs.status` is what will make a future Temporal migration mechanical.
- **`shared_context` is always injected; `context_items` are retrieved on demand.** The 64 KB cap on `teams.sharedContext` is enforced both at the API layer and as a constraint — it exists because this text goes into every prompt.
- **Content-addressed storage.** S3 holds immutable blobs addressed by SHA-256. Postgres holds what you query, join, or inject into a prompt.

## `packages/shared` Components

These are plain Tailwind components (no shadcn dependency yet). Use them for all new UI:
`Button` (variant primary/secondary), `Card`, `CardLink`, `Badge`, `TextInput`, `Textarea`, `PageHeader`, `Breadcrumb`, `TooltipBubble`, `Truncate`, `EmptyState`.
