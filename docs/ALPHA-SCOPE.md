# Alpha Scope — Remaining Engineering Tasks

> Date: 2026-08-04
> Source: [Tasks by architecture spreadsheet](https://docs.google.com/spreadsheets/d/1iRDgz5U2jENXQCqgMrwFirJ7InoiWB470QOhLllZsAw/edit?gid=1478480426#gid=1478480426) cross-referenced with ARCHITECTURE.md and PRODUCT-DEFINITION.md

## Context

Everything already built (auth, orgs, teams CRUD, agents list/detail, session chat, worker + BullMQ + Claude Agent SDK, GitHub App, Docker sandbox, Postgres schema) is part of the alpha. This document covers the **remaining tasks from the engineering backlog** and recommends which to include vs. defer.

The spreadsheet contains 39 remaining tasks across milestones M1–M6. None are complete yet.

---

## Include in alpha (6 items)

These items close safety gaps or unblock the core loop. Without them the alpha either runs unsafely or can't demonstrate its value.

| # | Task | Milestone | Why it's needed |
|---|------|-----------|-----------------|
| 1 | Wire `PolicyEngine.decide()` into the SDK permission callback for allow/deny tool enforcement | M1 | Without this, agents run with `bypassPermissions` and the SDK's full default toolset — no deny-by-default policy is enforced. Unsafe for any real use. |
| 2 | Emit `policy_decision` events for every allow/deny decision | M1 | Goes hand-in-hand with the policy engine — you need the audit trail to know what the agent was allowed and denied. |
| 3 | Enforce per-run budget caps (maxTokens / maxWallClockSec / maxCostUsd) and terminate looping runs | M1 | `runs.budgetExceeded` column exists but nothing ever sets it; no cap logic in `worker.ts` or `run-turn.ts`. A looping agent on the platform API key with no cap is a runaway bill. |
| 4 | Compose the full context-assembly pipeline (preamble + shared_context + agent.system_prompt + skills index + connection tool docs) and hash into `runs.prompt_hash` | M1 | Right now `worker.ts` sends `agent.systemPrompt` raw. The alpha needs team `shared_context` actually injected into prompts — otherwise teams are meaningless. |
| 5 | Build the Agent edit form (model, tool policy, skills picker, connections picker, mode) | Frontend | No `/agents/:id/edit` page exists. Users can view agents but can't configure them. |
| 6 | Verify Sandbox gate: docker is unreachable inside sandbox, rootfs is read-only outside `/workspace`, non-allowlisted egress fails, and a `while(true)` loop is killed by the wall-clock limit with the container removed | General | `CapDrop`/`no-new-privileges`/resource limits are implemented in `docker-sandbox-provider.ts`, but there's no egress allowlist proxy and no confirmed wall-clock kill test. Agents execute untrusted code — without verified containment the sandbox is a liability. |

---

## Discuss — strong candidates (3 items)

These make the alpha feel complete and safe but depend on how polished we want the first release to be.

| # | Task | Milestone | Consideration |
|---|------|-----------|---------------|
| 7 | Build the Connections/OAuth screen beyond the current GitHub-only flow | Frontend | GitHub App connect/callback exists; a general multi-provider Connections screen is incomplete. Needed if alpha users connect more than GitHub. |
| 8 | Set up integration tests that run adapters against recorded provider fixtures, and a sandbox-lifecycle test against a real container | General | No automated tests exist for GitHub/Slack/Jira adapters; sandbox lifecycle isn't covered by any test. Risky to ship alpha without at least sandbox lifecycle tests. |
| 9 | Verify Budget gate: an agent looping on tool calls hits the per-run cap and terminates with a done/budget-exceeded event, no orphaned container | M1 | The verification of item #3 above. Without this test, budget enforcement is unproven. |

---

## Defer — post-alpha (30 items)

These are all nice-to-have but the alpha can ship and be useful without them. Grouped by theme.

### M1 items deferred

| Task | Why defer |
|------|-----------|
| Persist events to Postgres (append-only event log) | Events exist in-memory during runs. Full persistence matters for replay/audit but alpha can work without it. |
| Decompose run into idempotent `Step<I,O>` pipeline (resolveCredentials → composeContext → provisionSandbox → cloneRepo → executeRun → finalizeArtifacts → teardown) | Temporal-readiness. Over-engineered for alpha — the current single-function worker works. |
| Enforce per-org monthly budget cap | Per-run caps (included above) are enough for alpha. Org-level is a billing concern. |
| Implement `resolveCredentials(orgId)` for platform-key vs BYO-key resolution | Alpha can hardcode the platform key. BYO is an enterprise concern. |
| Verify Portability gate (kill worker mid-run, resume from `runs.status`) | Depends on the Step decomposition which is also deferred. |

### Data model gaps

| Task | Why defer |
|------|-----------|
| Build invite flow (invite by email → pending membership → accept) | Register always creates a new org. Single-user-per-org works for early alpha testing. Multi-user needs this. |
| Stand up `apps/api` as a separately deployed API process | Explicitly deferred in the architecture until a real external caller shows up. |

### M2 — Coding agents (3 items)

| Task | Why defer |
|------|-----------|
| Verify Containment gate (PR with injected instructions → `policy_decision: deny`) | Needs the M1 policy engine first; not yet testable. |
| Verify M2 gate (Code reviewer mock agent on a real PR, posts review, artifacts contain PR URL) | Artifacts table does not exist yet in `schema.ts`. |
| Persist artifact events (PR URL, diff, file, report) to an artifacts table | `ArtifactEvent` type exists in `events.ts`; no artifacts table in schema. |

### M3 — Context (5 items)

| Task | Why defer |
|------|-----------|
| Build `content_blobs` (S3, SHA-256-addressed) for `team_context_items` uploads | Metadata-only stub exists per code comment — no S3 upload pipeline. |
| Build `context_chunks` table + embedding pipeline (chunk → embed → pgvector HNSW index) + top-k retrieval scoped to `team_id` | No pgvector/embedding/context_chunks references in the codebase. |
| Build skills library backend: `skills` / `skill_versions` / `agent_skills` tables (content-addressed S3 bundle, version pinning) | `/api/skills` still reads from the in-memory mockStore; none of these tables exist in `schema.ts`. |
| Wire retrieved context items and skills index into the context-assembly pipeline (the §3 deliverable) | Same gap as the M1 context-assembly item — listed here since §3 is explicitly the M3 milestone. |
| Build the Skills library UI (list, editor/import, upgrade-a-version flow) | No skills pages exist beyond the mock list. |

### M4 — Channels (2 items)

| Task | Why defer |
|------|-----------|
| Map a Slack thread 1:1 to a Session, populating `sessions.external_thread_ref` | `sessionOriginEnum` includes "slack" but nothing populates `external_thread_ref` from a real Slack event. |
| Build the Slack ChannelAdapter (receive raw → InboundMessage, send outbound) | No channel adapter code exists. |

### M5 — Automation (5 items)

| Task | Why defer |
|------|-----------|
| Build the triggers matching engine with idempotency (dedupe on provider event id) and loop protection | `Trigger` and `TriggerSource` types exist in `domain.ts`; no triggers table or matching logic. |
| Build the inbound webhook bus: `POST /webhooks/:provider` → signature verification → normalize to `PlatformEvent` | Only GitHub App install/OAuth callback routes exist, not a generic webhook receiver. |
| Add Jira / Monday / Google Sheets integrations as MCP servers (tool access) and as trigger sources | Only the GitHub connection (scm) is real; task-system connections are not implemented. |
| Wire automatic mode: agents subscribe to enabled triggers and auto-enqueue runs without a human message | `agents.mode` already supports "automatic" as a value, but nothing currently acts on it. |
| Build the Triggers management UI | No triggers screen exists yet (mock coverage explicitly excludes Triggers). |

### M6 — Proof (5 items)

| Task | Why defer |
|------|-----------|
| Build a second `AgentRuntime` adapter (e.g. `OpenAIAgentsRuntime` or `PlainLLMRuntime`) without touching sessions, agents, or any API route | The architecture's stated abstraction proof — post-alpha. |
| Build a live run feed with one-click cancel | `AgentRuntime.cancel(runId)` is defined in the interface but there is no cancel implementation or route. |
| Build org-wide pause (kill switch) | Not implemented anywhere in the API or worker. |
| Build an Audit log UI surfacing `policy_decisions` and `audit_log` entries | Neither `policy_decisions` nor `audit_log` tables exist in `schema.ts` yet. |
| Build a Run cost/usage view | No `usage_records` table exists yet and no usage/cost page exists in `apps/web`. |

### Open questions from §11 (2 items)

| Task | Why defer |
|------|-----------|
| Implement sticky-session routing at the load balancer for multi-node warm-container affinity | Currently single-node; `sessions.sandboxId` is only meaningful on the node that created the container. |
| Implement periodic SessionSnapshot compaction (system prompt, truncated turn history, latest file state) for failover resilience | No `SessionSnapshot` table or snapshot logic exists. |

---

## Summary

| Category | Count |
|----------|-------|
| Include in alpha | 6 |
| Discuss | 3 |
| Defer | 30 |
| **Total remaining tasks** | **39** |

The alpha cut line prioritizes **safety** (policy engine, budget caps, sandbox verification) and **usability** (agent editing, context injection). Everything else — Temporal readiness, multi-provider integrations, channels, automation, audit/usage UIs — ships post-alpha.
