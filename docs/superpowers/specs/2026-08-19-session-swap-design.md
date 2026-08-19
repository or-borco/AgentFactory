# Post-session reassignment & codebase swap — design spec

**Date:** 2026-08-19
**Status:** approved

## Problem

Once a task has a session, its Assignee is locked (per `docs/superpowers/specs/2026-08-17-task-edit-page-design.md`, already shipped in [#98](https://github.com/or-borco/AgentFactory/pull/98)) and Codebase has no editor at all. Reassigning a stuck task to a different agent, or fixing a task pointed at the wrong repo, currently means abandoning it and creating a new one by hand — there's no way to redirect an existing task's work.

## Goal

Let Assignee and Codebase be changed even after a session exists, by ending that session's sandbox and letting the task start a fresh one — reusing the existing "start a session" machinery rather than building new provisioning code.

## Ground truth this design relies on

Established during investigation (file:line references from the current `main`):

- **`session.agentId` is immutable.** No repository function updates it (`packages/db/src/repositories/sessions.ts`). A session can't be "reassigned" in place — swapping the agent means creating a *different* session.
- **A task gets exactly one session via `POST /api/tasks/[taskId]/run`**, which 409s if `task.sessionId` is already set (`apps/web/src/app/api/tasks/[taskId]/run/route.ts:43-44`). That endpoint already does everything needed to provision a fresh sandbox for a task with no session — nothing new is needed there.
- **Teardown already exists and is idempotent**: `enqueueSandboxTeardownJob(sessionId)` → `sandboxTeardownWorker` → `DockerSandboxProvider.destroy` (stop + remove, both swallowing errors) → `clearSessionSandboxId` (`packages/queue/src/index.ts:13-15,31-33`; `apps/worker/src/worker.ts:261-271`; `apps/worker/src/sandbox/docker-sandbox-provider.ts:232-238,240-247`). Already triggered today from `PATCH /api/tasks/[taskId]` on a terminal-status transition and from `DELETE` (`apps/web/src/app/api/tasks/[taskId]/route.ts:19-33,35-48`).
- **`cloneIntoSandbox` already guards against a stale checkout**: if a session's container already has a different repo cloned than `task.codebase`, it throws `REPO_MISMATCH` rather than silently continuing in the wrong repo (`apps/worker/src/scm-provider.ts:144-198`). The comment there was written anticipating exactly this feature — today that's a runtime error on the next run; this design acts on the same condition proactively instead.
- **No run-cancellation mechanism exists anywhere** (confirmed by grep across `apps/worker/src` and `apps/web/src/app/api`) — `cancelled` exists as a status value but nothing transitions a run into it or interrupts an in-flight job.
- **Branch naming is keyed off session id** (`agent/session-<id>`, `apps/worker/src/worker.ts:95`), not task id — a new session automatically gets a new branch with zero extra plumbing.
- **`task.prNumber`/`task.prUrl` are never cleared anywhere** today — set once by `openDraftPullRequest` (`apps/worker/src/worker.ts:203-217`) and otherwise untouched.
- **`sessions` has no back-reference to the task that created it** — the relationship today is one-directional (`tasks.session_id` → `sessions.id`), no `sessions.task_id` column (`packages/db/src/schema.ts:154-170,246-284`).
- The `queued → provisioning → running → finalizing → done|failed|cancelled` run state machine already has full UI copy for every non-terminal state (`runStatusLabel`, `apps/web/src/app/(app)/tasks/[taskId]/page.tsx:1037-1049`) — reusable as-is for a swap's "tearing down / starting fresh" period, since it's really just "the task has no active session right now," the same state a brand-new task is in.

## Scope

- `packages/db/src/schema.ts` — add nullable `sessions.task_id`, migration + trivial backfill (today's data is 1:1: `tasks.session_id`).
- `packages/db/src/repositories/sessions.ts` — `listSessionsForTask(taskId): Promise<Session[]>`; set `taskId` at session creation.
- `packages/core/src/domain.ts` — `Session.taskId?: ID`; widen `Task.prNumber?: number | null`, `Task.prUrl?: string | null` (same clearing-needs-`null`-not-`undefined` fix already applied to `area`/`codebase` in #98).
- `packages/db/src/repositories/tasks.ts` — matching `UpdateTaskInput` widening for `prNumber`/`prUrl`; `toTask` stops normalizing `?? undefined`.
- `apps/web/src/app/api/tasks/[taskId]/route.ts` (`PATCH`) — one more teardown trigger: when the request body sets `sessionId: null` on a task that currently has one, enqueue teardown for the *old* session id (fetched via `getTask` before the update — same precedent the `DELETE` handler already uses).
- New route: `GET /api/tasks/[taskId]/sessions` — past sessions for this task (excludes the current `task.sessionId`), for the history UI.
- `apps/web/src/components/AssigneeSelect.tsx` — widen the existing pre-session-only gate.
- New: `apps/web/src/components/CodebaseSelect.tsx` — same `<select>`-of-connected-repos pattern already used in `tasks/new/page.tsx` and (today) the edit page.
- `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` — wire up `CodebaseSelect`; widen `AssigneeSelect`'s gate; shared `handleSwap` action; confirmation dialog; "Previous sessions" list + read-only session viewer.
- `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx` — remove Codebase (moves to the inline editor above); keeps Description/Criteria/Area.

## Out of scope

- Mid-run swap / any run-cancellation mechanism — swap is only available when `!isRunning`. Building interruption is a separate, larger feature.
- Anything touching the orphaned GitHub PR (closing it, commenting on it) — `prNumber`/`prUrl` are unlinked from the task on swap; the PR itself is left exactly as it was on GitHub.
- The tasks *list* page — this feature only touches the task detail page, matching the precedent set in #98.
- Any new provisioning code — swap is entirely built from the existing detach → (existing) teardown → (existing) "Run agent" flow.

## Design decisions

- **Swap = detach, not a new provisioning primitive.** Since a task can only ever acquire a session through the existing `/run` endpoint (which already provisions on demand), the entire feature is: tear down the old sandbox, clear `task.sessionId`/`prNumber`/`prUrl`, revert status — after which the task *is*, architecturally, a pre-session task again, and the "Run agent" button plus the existing Assignee editor (already gated on `!task.sessionId`) just naturally re-enable. No new "reprovision" code path exists anywhere in this design.
- **Blocked while running, not queued or interrupted.** No cancellation mechanism exists; building one is out of scope. The guard is the same `isRunning` flag the page already computes.
- **Codebase gets its own inline editor, not a page.** It shares Assignee's semantics now (a swap-trigger once a session exists), not the "frozen spec" semantics of Description/Criteria/Area — grouping it with those on the edit page conflated two different kinds of field. It moves to the Details panel as a dropdown (never free text), mirroring `AssigneeSelect` exactly.
- **One shared swap action for both fields.** Changing either Assignee or Codebase (or both, in immediate succession) drives the same `handleSwap`: confirm → detach with whichever field changed. There's no combined "reassign + re-codebase" form — each field's own control triggers the shared action independently, since after detach the task is back in its normal pre-session state where both fields are already independently editable.
- **Confirmation required only when a session already exists.** Pre-session, both dropdowns keep today's instant-apply behavior (cheap, non-destructive, no session to lose). Post-session, either dropdown's `onChange` opens a `ConfirmDialog` (reusing the pattern already shipped for destructive status changes in #98) before anything happens.
- **Old sessions stay in the database and stay browsable**, not deleted and not silently hidden. This is why `sessions.task_id` is added: without a back-reference, there'd be no way to list a task's session history at all.

## Mechanism

### Schema: `sessions.task_id`

Nullable (not every session origin need be task-scoped in principle, and it avoids a NOT-NULL backfill risk), set once at session creation, never changed afterward — it's "which task created this session," not "which task currently owns it" (that's still `tasks.session_id`, which *does* change on swap). A task's full history is `SELECT * FROM sessions WHERE task_id = $1 ORDER BY created_at DESC`.

### Server: extending the existing `PATCH` teardown trigger

```ts
export async function PATCH(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const body = await req.json();
  const before = await getTask(Number(taskId));
  const task = await updateTask(Number(taskId), body);

  if (body.status && TERMINAL_TASK_STATUSES.has(task.status) && task.sessionId) {
    await enqueueSandboxTeardownJob(task.sessionId);
  }
  if (body.sessionId === null && before?.sessionId) {
    await enqueueSandboxTeardownJob(before.sessionId);
  }

  return NextResponse.json(task);
}
```

The extra `getTask` read mirrors what the `DELETE` handler in the same file already does before acting — not a new pattern, just extended to `PATCH`. It's needed because by the time `updateTask` returns, `task.sessionId` is already null; the *old* id has to be captured before the write.

### Client: the shared swap action

```ts
const handleSwap = async (patch: { assigneeAgentId?: number; codebase?: string }) => {
  if (!task) return;
  const assigneeAgentId = patch.assigneeAgentId ?? task.assigneeAgentId;
  await updateTask(task.id, {
    ...patch,
    sessionId: null,
    status: assigneeAgentId ? "assigned" : "open",
    prNumber: null,
    prUrl: null,
  });
};
```

`status` reuses the exact same "assignee present → assigned, else → open" rule `handleAssigneeChange` already applies pre-session — no new status logic, just applied at a second call site.

### `AssigneeSelect` / `CodebaseSelect` gating

Both fields render their `<select>` whenever `!task.sessionId || !isRunning` (today `AssigneeSelect` only renders when `!task.sessionId`; `CodebaseSelect` is new but follows the same rule from day one). `onChange` behavior branches on whether a session currently exists:

- **No session:** apply immediately via the existing per-field update (`AssigneeSelect`'s current `handleAssigneeChange` path, unchanged; `CodebaseSelect` gets an equivalent instant-apply `handleCodebaseChange`).
- **Session exists (and idle):** open a `ConfirmDialog` — "Reassign to {agent}?" / "Change codebase to {repo}?" plus a fixed body explaining the session will end and its sandbox torn down — `onConfirm` calls `handleSwap({ assigneeAgentId })` or `handleSwap({ codebase })`.

### Previous sessions

`GET /api/tasks/[taskId]/sessions` returns `listSessionsForTask(taskId)` filtered to exclude `task.sessionId` (the current one already has its own live Transcript tab). The detail page renders a small "Previous sessions ({n})" list near the existing Transcript/Files tab bar, only when non-empty. Selecting one sets a `viewingSessionId` state; while set, the transcript pane fetches and renders that session's messages read-only — no reply bar, no run-status polling, since it's history, not a live conversation — with a link back to the current view (clears `viewingSessionId`).

## Edge cases

- **Swap while `!task.sessionId`:** not reachable — both dropdowns already apply instantly in that state, there's nothing to detach.
- **Task already at a terminal status (done/failed/cancelled) when swapped:** its sandbox may already be torn down by the existing terminal-status trigger; the new `sessionId === null` teardown trigger just no-ops (the queue job already tolerates a missing/already-cleared `sandboxId`, per `worker.ts:261-271`'s `if (!session?.sandboxId) return;`). Swapping a finished task's assignee/codebase becomes a natural way to restart it with a different agent or repo — a side effect of the design, not a special case that needed extra code.
- **Unassigning via the post-session `AssigneeSelect`:** same as today's pre-session behavior — status becomes `open` rather than `assigned`. The task still detaches from its session either way.
- **Codebase repo list empty:** `CodebaseSelect` shows the same empty-state affordance the edit page's codebase field already has today (link to `/connections`).
- **Two swaps in quick succession** (e.g., change Assignee, confirm, then immediately change Codebase again before a new session exists): both go through the same pre-session instant-apply path the second time, since after the first swap `task.sessionId` is already null — no special handling needed.

## Testing

- No test infrastructure exists today for `tasks/[taskId]/page.tsx`, matching #98's precedent — no new test file for the page-level wiring.
- `packages/db/src/repositories/sessions.ts`'s existing test coverage (if any — to confirm during planning) gets `listSessionsForTask` added to it.
- Manual verification in the browser: swap while idle (both fields, both confirm-dialog paths), swap blocked while `isRunning` (both dropdowns revert to plain static text, per the `!task.sessionId || !isRunning` gate above — same fallback the page already renders today whenever `AssigneeSelect` doesn't apply), previous-sessions list appears after a swap and shows the old transcript read-only, `prNumber`/`prUrl` clear on swap and the old PR is otherwise untouched on GitHub.

## Implementation plan / PR split

Given the size (schema migration + new endpoint + new component + edit-page revision + history UI), this warrants sequencing rather than one PR — final split to be decided during planning, but likely:

1. Data layer: `sessions.task_id` migration, `listSessionsForTask`, `prNumber`/`prUrl` widening.
2. Server: `PATCH` teardown-on-detach trigger, `GET /api/tasks/[taskId]/sessions`.
3. `CodebaseSelect` component + wiring both dropdowns' instant-apply (pre-session) paths — no swap yet, `CodebaseSelect` just reaches parity with where `AssigneeSelect` already was in #98.
4. The swap flow itself: gating, confirmation, `handleSwap`.
5. Previous-sessions list + read-only session viewer.
6. Remove Codebase from the edit page.
