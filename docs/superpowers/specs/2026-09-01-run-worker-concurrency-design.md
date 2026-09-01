# Run worker concurrency: same-session serialization — design spec

**Date:** 2026-09-01
**Status:** approved
**Issue:** [#101](https://github.com/or-borco/AgentFactory/issues/101)

## Problem

Issue #101 reports that `runWorker` defaulted to BullMQ's concurrency of 1, so queued runs — for any task, agent, or org — waited behind each other even though nothing about a run actually requires that.

That specific bug is already fixed: PR [#119](https://github.com/or-borco/AgentFactory/pull/119) raised `runWorker`'s concurrency to a tunable `RUN_WORKER_CONCURRENCY` (default 5) and its `lockDuration` to 15 minutes, reasoning that "each run gets its own isolated Docker sandbox, so runs against different sessions are already isolated."

That reasoning has a gap the issue itself flagged as an ordering caveat, and it's now live: **runs within the same session are not isolated.** They share one warm sandbox (`ensureSandbox` in `apps/worker/src/worker.ts`) and the same `/workspace` checkout inside it. Nothing prevents two runs for the same session from being enqueued (`enqueueRunJob` has no dedup or lock keying — see `packages/queue/src/index.ts:50` and its two callers) or from being picked up by two of the five concurrent worker slots at once. When that happens, `cloneIntoSandbox`/`pushChangesIfDirty` from two turns interleave against the same git working tree, corrupting it.

This spec closes that gap and finishes the remaining acceptance criteria from #101.

## Ground truth this design relies on

- `runWorker`'s concurrency and `lockDuration` are already correct (`apps/worker/src/worker.ts:395-408`); this spec does not touch those values, only extracts the concurrency parsing into a testable function.
- `ensureSandbox(session)` (`worker.ts:69`) is session-scoped: one warm sandbox is reused across all of a session's runs, and the whole point of keeping it warm is that the SDK's resume mechanism needs the same container filesystem across turns.
- `sessions` (`packages/db/src/schema.ts:168`) already carries session-scoped mutable state (`sandboxId`) written and cleared via dedicated repository functions (`setSessionSandboxId`/`clearSessionSandboxId` in `packages/db/src/repositories/sessions.ts`) — the pattern this design's lock columns follow.
- CLAUDE.md's architecture principle: "Run state lives in Postgres, never in closures" — the explicit state machine on `runs.status` is what makes a future Temporal migration mechanical. A same-session lock is run-adjacent state and belongs in the same place.
- BullMQ (`^5.81.2`, already a dependency) supports a documented pattern for exactly this shape of problem — a job that finds its resource unavailable reschedules itself via `job.moveToDelayed(timestamp, token)` then `throw new DelayedError()`, which BullMQ handles specially: the job returns to the delayed state without counting as a failure or consuming a retry attempt. The processor must declare `(job, token)` to receive the token.
- `enqueueRunJob` (`packages/queue/src/index.ts:50`) is called from exactly two places, both immediately after creating a `Run` row: `apps/web/src/app/api/tasks/[taskId]/run/route.ts:53-54` and `apps/web/src/app/api/sessions/[sessionId]/messages/route.ts:24-25`. Neither checks for an in-flight run on the session — by design, this spec doesn't change that (see Out of scope); serialization happens worker-side.
- The issue's own "How to verify" section requests a `resolveConcurrency(env)` export and a `worker-concurrency.test.ts` file — never actually added when #119 inlined the `Number(...)` expression.
- `sandboxTeardownWorker` and `repoMapWarmWorker` (`worker.ts:420`, `worker.ts:439`) still have no `concurrency` option and default to BullMQ's 1, the same class of issue as the original bug, cited as evidence in #101 but not covered by #119's fix (which only touched `runWorker`).

## Scope

- `packages/db/src/schema.ts` — new nullable `sessions.active_run_id` / `active_run_locked_at` columns, plus migration.
- `packages/db/src/repositories/sessions.ts` — `tryAcquireSessionRunLock`, `releaseSessionRunLock`.
- `apps/worker/src/session-lock.ts` (new) — `claimSessionOrDelay`, the testable glue between the DB lock and BullMQ's delayed-retry mechanism.
- `apps/worker/src/worker.ts` — `runWorker` processor claims the lock before doing any work and releases it in a `finally`; processor signature gains the `token` parameter. `resolveConcurrency(env)` extracted from the inline expression. `sandboxTeardownWorker`/`repoMapWarmWorker` gain fixed `concurrency` values.
- Tests: `packages/db/src/__tests__/repositories/sessions.test.ts` (extended), `apps/worker/src/__tests__/session-lock.test.ts` (new), `apps/worker/src/__tests__/worker-concurrency.test.ts` (new).

## Out of scope

- **Enqueue-time rejection or dedup.** A second message sent while a run is in flight still enqueues and queues up behind it — matching normal chat-like UX. Only worker-side execution is serialized.
- **Strict FIFO ordering of queued same-session runs.** Two delayed jobs racing to reclaim a freed lock could occasionally execute out of enqueue order. The issue's acceptance criteria require no interleaving, not ordering, and sessions rarely have more than one queued run at a time.
- **GitHub call volume / installation-token caching** (issue's "#2" reference). Explicitly flagged in #101 as a separate concern to land before raising concurrency further; concurrency isn't being raised further here.
- **A crash-recovery fix for runs stuck at `status: "running"` forever after a hard worker crash.** Pre-existing gap (the catch block that would mark a run `failed` never runs if the process dies first); this design's staleness window keeps that same crash from also permanently blocking the session's queue, but doesn't fix the run's own stuck status.
- **`evalWorker` / `contextIngestWorker` concurrency.** Not named in #101, not part of the run pipeline's sandbox-sharing problem.

## Design decisions

- **Lock lives on `sessions`, in Postgres, not Redis.** Follows the existing `sandboxId` pattern exactly and keeps run-adjacent state inspectable with a normal `SELECT` — consistent with CLAUDE.md's "run state lives in Postgres, never in closures." A Redis lock would work mechanically but adds a second, less visible source of truth for something this codebase already keeps in one place.
- **Compare-and-swap via a single `UPDATE ... WHERE ... RETURNING`, not a separate check-then-set.** `tryAcquireSessionRunLock` claims atomically: `WHERE active_run_id IS NULL OR active_run_locked_at < staleBefore`. Zero returned rows means "someone else holds it, and it's not stale" — no race between check and set.
- **20-minute staleness window, not a TTL-free lock.** Without it, a hard worker crash mid-run (process dies before the `finally` releases the lock) would permanently block every future run in that session — worse than today, where an unlocked queue at least keeps processing. 20 minutes mirrors the existing `lockDuration: 15 * 60 * 1000` comment in `worker.ts` (BullMQ's own job-lock reclaim window) plus margin, so the lock self-heals on roughly the same timescale BullMQ already uses for its own stalled-job detection.
- **Release is also a CAS, not a blind clear.** `releaseSessionRunLock` only clears the lock `WHERE active_run_id = runId` — if a stale lock was already reclaimed by a newer run before the original (very late, e.g. post-crash-recovery) release call runs, that newer run's lock must survive.
- **Delayed retry, not job failure, on contention.** Using BullMQ's `moveToDelayed` + `DelayedError` pattern means a run waiting for its session's turn never shows up as a failed/retried job — it just sits delayed and re-checks every 3 seconds. Fixed interval, no backoff: the wait is bounded by the holder's own turn (40s–15min), so responsiveness matters more than avoiding a handful of cheap indexed `UPDATE`s.
- **Claim happens before any work, release happens in the run processor's existing `finally`.** The claim is a single early call right after `getRun`; nothing about the sandbox, clone, or agent turn logic changes. Release is one line added to the processor's existing `try {...} catch {...}` as a `finally` clause — no restructuring of the ~300-line handler.
- **Lock/delay decision extracted into its own function (`claimSessionOrDelay`) instead of inlined in the processor.** `worker.ts` already has no test file because BullMQ `Worker` options and processors are awkward to test in place (the issue's own words, about the concurrency setting). Pulling just the claim-or-delay branch into a standalone function with a plain `(job, token, sessionId, runId)` signature makes it unit-testable against a mocked `job` and mocked DB functions, without needing a live Worker.

## Mechanism

### Schema (`packages/db/src/schema.ts`)

```ts
export const sessions = pgTable("sessions", {
  // ...existing columns...
  // Session-scoped run lock: which run currently owns this session's sandbox/workspace, and
  // when it claimed it. Null when no run is in flight. A run claims this before touching the
  // sandbox and clears it when done (worker.ts's session-lock.ts); a lock older than the
  // staleness window is reclaimable, so a crashed worker can't permanently stall the session.
  activeRunId: integer("active_run_id").references(() => runs.id),
  activeRunLockedAt: timestamp("active_run_locked_at", { withTimezone: true }),
});
```

Generated via `pnpm --filter @agentfactory/db db:generate`.

### Repository (`packages/db/src/repositories/sessions.ts`)

```ts
const LOCK_STALE_AFTER_MS = 20 * 60 * 1000; // matches worker.ts's 15min lockDuration + margin

export async function tryAcquireSessionRunLock(sessionId: number, runId: number): Promise<boolean> {
  const staleBefore = new Date(Date.now() - LOCK_STALE_AFTER_MS);
  const [row] = await db
    .update(sessions)
    .set({ activeRunId: runId, activeRunLockedAt: new Date() })
    .where(and(
      eq(sessions.id, sessionId),
      or(isNull(sessions.activeRunId), lt(sessions.activeRunLockedAt, staleBefore)),
    ))
    .returning();
  return row !== undefined;
}

export async function releaseSessionRunLock(sessionId: number, runId: number): Promise<void> {
  await db
    .update(sessions)
    .set({ activeRunId: null, activeRunLockedAt: null })
    .where(and(eq(sessions.id, sessionId), eq(sessions.activeRunId, runId)));
}
```

### Worker glue (`apps/worker/src/session-lock.ts`, new)

```ts
import type { Job } from "bullmq";
import { DelayedError } from "bullmq";
import { tryAcquireSessionRunLock } from "@agentfactory/db";
import type { RunJobData } from "@agentfactory/queue";

const SESSION_LOCK_RETRY_MS = 3000;

// Claims the session for this run, or reschedules the job a few seconds out via BullMQ's
// documented delayed-retry pattern when another run already holds the session's lock. Not a
// failure and doesn't consume a retry attempt.
export async function claimSessionOrDelay(
  job: Job<RunJobData>,
  token: string,
  sessionId: number,
  runId: number,
): Promise<void> {
  if (await tryAcquireSessionRunLock(sessionId, runId)) return;
  await job.moveToDelayed(Date.now() + SESSION_LOCK_RETRY_MS, token);
  throw new DelayedError();
}
```

### Worker integration (`apps/worker/src/worker.ts`)

```ts
const runWorker = new Worker<RunJobData>(
  RUN_QUEUE_NAME,
  async (job, token) => {
    const { runId } = job.data;
    const mark = phaseTimer(runId);
    const run = await getRun(runId);
    if (!run) return;
    mark(`picked up (queued ${Date.now() - new Date(run.createdAt).getTime()}ms)`);

    await claimSessionOrDelay(job, token, run.sessionId, runId);

    let attemptModel: ModelSpec | undefined;
    let seq = 1;
    try {
      // ...existing body, unchanged...
    } catch (err) {
      // ...existing catch, unchanged, still ends with throw err...
    } finally {
      await releaseSessionRunLock(run.sessionId, runId);
    }
  },
  { /* unchanged options */ },
);
```

`resolveConcurrency` extraction:

```ts
export function resolveConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.RUN_WORKER_CONCURRENCY);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5; // 5 matches PR #119's shipped default
}
```

used as `concurrency: resolveConcurrency()` in the `runWorker` options.

`sandboxTeardownWorker` and `repoMapWarmWorker` gain fixed concurrency:

```ts
const sandboxTeardownWorker = new Worker<SandboxTeardownJobData>(
  SANDBOX_TEARDOWN_QUEUE_NAME,
  async (job) => { /* unchanged */ },
  { connection: queueConnection, concurrency: 5 }, // cheap docker rm; no reason to serialize
);

const repoMapWarmWorker = new Worker<RepoMapWarmJobData>(
  REPO_MAP_WARM_QUEUE_NAME,
  async (job) => { /* unchanged */ },
  { connection: queueConnection, concurrency: 3 }, // spins up a sandbox, closer in weight to a real run
);
```

### Tests

**`packages/db/src/__tests__/repositories/sessions.test.ts`** (extended, real Postgres):
- `tryAcquireSessionRunLock` succeeds when `active_run_id` is null
- a second call for a different `runId` on the same session fails while the first lock is held
- a call for a different `sessionId` succeeds while another session's lock is held (proves no cross-session blocking)
- a lock older than `LOCK_STALE_AFTER_MS` is reclaimable by a different `runId`
- `releaseSessionRunLock` clears the lock only when `runId` still matches; a mismatched `runId` leaves the lock untouched

**`apps/worker/src/__tests__/session-lock.test.ts`** (new, vitest `unit` project):
- lock acquired (mocked `tryAcquireSessionRunLock` resolves `true`) → `claimSessionOrDelay` resolves without calling `job.moveToDelayed`
- lock not acquired (mocked resolves `false`) → calls `job.moveToDelayed` with a future timestamp and the given token, and throws `DelayedError`

**`apps/worker/src/__tests__/worker-concurrency.test.ts`** (new, vitest `unit` project):
- unset → `5`
- `"6"` → `6`
- `"0"`, `"-1"`, `"abc"`, `"2.5"` → falls back to `5`

**Manual verification** (not automated — end-to-end interleaving across two live worker slots is expensive to assert reliably, and the unit-level coverage above already proves the CAS semantics that make interleaving impossible): send two messages back-to-back on the same session, confirm the second run's events don't begin until the first reaches a terminal status, and that both runs still complete (not one silently dropped).

Run: `pnpm test:unit` (session-lock, worker-concurrency), `pnpm test:db` (sessions repository — needs `docker compose up -d` for Postgres per existing db test setup).

## Follow-ups (explicitly not this spec)

- Fix the pre-existing gap where a hard worker crash leaves a run stuck at `status: "running"` forever (the catch block that marks it `failed` never runs if the process dies first).
- GitHub installation-token caching (#2), before `RUN_WORKER_CONCURRENCY` is raised beyond its current default.
- Enqueue-time UX (e.g. showing "a run is already in progress" before the user sends a second message) — currently invisible; the message still sends and queues correctly, just without an early indicator.
