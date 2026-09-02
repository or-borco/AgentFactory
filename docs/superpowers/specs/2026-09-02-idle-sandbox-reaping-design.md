# Idle sandbox reaping — design spec

**Date:** 2026-09-02
**Status:** approved

## Problem

Sandbox teardown today only fires on three explicit triggers: a task is marked done, a task is deleted, or a run fails (`apps/worker/src/worker.ts:387-393`, added by or-borco/AgentFactory#49 and the failure-path teardown call). A session's sandbox is otherwise kept warm indefinitely — reused across runs by design (`ensureSandbox`, `apps/worker/src/worker.ts:70-81`), but with no path back to "torn down" for a session that simply never reaches one of those three trigger states.

This is not hypothetical: investigating T-063's failure surfaced five containers that had been running for 7–13 days, four of them attached to sessions with no `task_id` at all (orphaned — created, then never revisited) and one attached to a task that had already failed 12 days earlier. Each was capped at up to 2048 MB by the existing grow/shrink memory logic (or-borco/AgentFactory#83), and together they left no real headroom in the local Docker VM's 2 GB budget. When T-063's own run tried to grow its sandbox under memory pressure, the kernel OOM-killed its agent process instead.

`ARCHITECTURE.md:352` already states the intended design — "Ephemeral: destroyed after idle timeout, never reused across orgs" — and `ARCHITECTURE.md:360` names a concrete number: "kept warm with an idle timeout (~15 min), then torn down." Neither has ever been implemented; only the three event-based triggers exist.

## Goal

A sandbox that goes idle — no session activity for longer than a fixed threshold — is torn down automatically, regardless of its task's status, on a periodic sweep. This closes the gap the three existing triggers don't cover (orphaned sessions, and any future case where an event-based trigger fails to fire) rather than adding a fourth special-cased trigger.

## Ground truth this design relies on

- **`sessions.lastActivityAt` already exists and is touched on every successful run completion.** `packages/db/src/schema.ts:183` (`timestamp("last_activity_at", ...).notNull().defaultNow()`); `touchSessionActivity` (`packages/db/src/repositories/sessions.ts:45-47`) does a plain `SET last_activity_at = now()`; called once, at the very end of a successful run (`apps/worker/src/worker.ts:373`, right after `updateRunStatus(runId, "done", ...)`). It is *not* touched continuously while a run is in progress — only at completion.
- **`runs.status` is the state machine `queued → provisioning → running → finalizing → done | failed | cancelled`** (`packages/db/src/schema.ts:204-211`, `runStatusEnum`). `done`, `failed`, `cancelled` are the only terminal values.
- **The existing teardown path is a plain BullMQ job keyed by `sessionId`, already idempotent.** `SANDBOX_TEARDOWN_QUEUE_NAME = "sandbox-teardown"` (`packages/queue/src/index.ts:5`), `SandboxTeardownJobData = { sessionId: number }` (`packages/queue/src/index.ts:20`), `enqueueSandboxTeardownJob(sessionId)` (`packages/queue/src/index.ts:65`). Its processor (`apps/worker/src/worker.ts:418-427`) no-ops if `session.sandboxId` is already null, and both `sandboxProvider.destroy()` (stop + remove, each `.catch(() => undefined)`, `apps/worker/src/sandbox/docker-sandbox-provider.ts:232-238`) and `clearSessionSandboxId` (`SET sandbox_id = NULL`, `packages/db/src/repositories/sessions.ts:53-55`) are safe to run more than once.
- **No non-terminal-run check exists in the teardown processor today.** It destroys unconditionally once invoked. This has been safe so far because all three existing triggers are direct consequences of the run/task lifecycle (a run fails → its own teardown call; a task is marked done or deleted → presumably no run is actively using that session at that moment). A time-based trigger has no such implicit guarantee.
- **No repeatable/cron-style BullMQ job exists anywhere in this codebase yet.** Every existing queue (`RUN_QUEUE_NAME`, `SANDBOX_TEARDOWN_QUEUE_NAME`, `REPO_MAP_WARM_QUEUE_NAME`, `EVAL_QUEUE_NAME`, `TEAM_CONTEXT_INGEST_QUEUE_NAME`, `TASK_CONTEXT_INGEST_QUEUE_NAME` — `packages/queue/src/index.ts:4-12`) is driven purely by explicit `enqueue*` calls from application code. This design introduces the first one.
- **`ARCHITECTURE.md:360` already names a concrete idle timeout ("~15 min") that was never implemented.** This design uses 2 hours instead (see Design decisions) and updates that line to match, rather than leaving the doc and the implementation disagreeing.

## Scope

- `packages/db/src/repositories/sessions.ts` — new `listIdleSandboxSessions(cutoff: Date)`.
- `packages/queue/src/index.ts` — new `SANDBOX_REAP_QUEUE_NAME`.
- `apps/worker/src/worker.ts` — new `sandboxReapWorker` + repeatable-job registration at startup; existing `sandboxTeardownWorker` processor gains a non-terminal-run re-check before destroying.
- `packages/db/src/repositories/runs.ts` — new `hasNonTerminalRun(sessionId)`, alongside the existing `getRunsForSession` (`packages/db/src/repositories/runs.ts:47-54`); used by the teardown worker's new safety check, and its underlying predicate mirrored in `listIdleSandboxSessions`'s query.
- `ARCHITECTURE.md:360` — updated from "~15 min" to match the threshold this design actually uses.

## Out of scope

- **Resizing the local Docker VM's memory allocation.** Host/infra config, not application code. It was the proximate cause of T-063's failure, but the reason there was no headroom to absorb it was leaked sandboxes — this design fixes that; VM sizing is a separate, orthogonal concern.
- **Changing the existing memory grow/shrink logic** (`watchMemory`, `resetMemory`, or-borco/AgentFactory#83). Unrelated mechanism — that logic manages a live sandbox's memory *cap*; this design manages whether a sandbox exists *at all*.
- **A configurable idle threshold** (per-org, via settings UI, or an env var). A fixed constant, consistent with how `MEMORY_BASE_MB`, `MEMORY_MAX_MB`, etc. are handled today. Can become configurable later if a real need shows up.
- **Idle-management behavior for future `SandboxProvider` adapters** (Fly Machines, E2B, gVisor — `ARCHITECTURE.md:39`). Those may have native TTL/auto-stop support that makes this reaper redundant for them; this design targets `DockerSandboxProvider` via the existing generic `destroy()` on the port, and doesn't attempt to anticipate what a future adapter needs.

## Design decisions

- **A periodic sweep, not a check-on-access.** The alternative — checking staleness inside `ensureSandbox` when a session's sandbox is about to be reused — only reclaims sandboxes for sessions someone eventually comes back to. The actual failure this design responds to was the opposite: four sessions with no task at all, never revisited by anything. A sweep is the only approach that reclaims sandboxes nothing will ever touch again.
- **Reuse the existing `sandbox-teardown` job rather than duplicating destroy logic.** The new reap job's only job is finding idle sessions and calling the same `enqueueSandboxTeardownJob` the two existing triggers already use. This keeps `destroy()` + `clearSessionSandboxId()` defined in exactly one place, and gives the new trigger the same retry/failure handling as the existing ones for free.
- **A fixed `jobId` on the repeatable-job registration.** `sandboxReapQueue.add("scan", {}, { repeat: { every: SANDBOX_REAP_INTERVAL_MS }, jobId: "sandbox-reap-scan" })`. BullMQ treats re-adding a repeatable job with the same `jobId` and repeat options as a no-op rather than a duplicate schedule — necessary here because `apps/worker/src/worker.ts` reloads on every file change under `tsx watch` in dev, and would otherwise register a new repeatable schedule on every reload.
- **2-hour idle threshold, deviating from `ARCHITECTURE.md:360`'s "~15 min," with that line updated to match.** 15 minutes is shorter than a realistic gap in a normal human review cycle (read a PR, think about it, come back with feedback) — at that threshold, a large fraction of genuinely-still-useful sessions would lose their warm sandbox and pay a re-clone on the very next legitimate reply. The "~15 min" figure reads as an early, parenthetical estimate rather than a deliberately load-bearing constraint anything else depends on today. 2 hours comfortably survives same-day back-and-forth while still reclaiming same-day rather than accumulating for days, matching what actually happened here.
- **15-minute sweep cadence.** Frequent enough to reclaim an idle sandbox reasonably promptly relative to a 2-hour threshold (worst case ~2h15m from last activity to actually torn down), infrequent enough that the scan query's cost is negligible.
- **Idle-reap applies uniformly regardless of task status.** A sandbox for a task sitting in `pr_open` or `review_cycle` is just as eligible as one for a task with no status path at all — `ensureSandbox` already recreates and re-clones on demand, so the only cost of tearing down an idle-but-not-abandoned sandbox is a slower next run, not lost work. Special-casing which task statuses are exempt would require the reaper to track task-status semantics it has no other reason to know about, for a benefit (avoiding an occasional re-clone) that doesn't justify the complexity.
- **The teardown worker gets a non-terminal-run re-check before destroying, applied to all three trigger paths, not just idle-reap.** Between the reap scan's query and the teardown job actually executing, a new run could start on that exact session — the query-time filter alone can't close that window. Re-checking immediately before `destroy()` closes it for real, and costs nothing extra for the two existing triggers (task-done, task-deleted) where a non-terminal run is already expected to be rare-to-impossible; if one is somehow found, skipping and letting the next relevant trigger retry is strictly safer than the current unconditional destroy.

## Mechanism

### New repository query

```ts
// packages/db/src/repositories/sessions.ts
export async function listIdleSandboxSessions(cutoff: Date): Promise<Session[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        isNotNull(sessions.sandboxId),
        lt(sessions.lastActivityAt, cutoff),
        notExists(
          db
            .select()
            .from(runs)
            .where(
              and(
                eq(runs.sessionId, sessions.id),
                inArray(runs.status, ["queued", "provisioning", "running", "finalizing"]),
              ),
            ),
        ),
      ),
    );
  return rows.map(toSession);
}
```

The non-terminal-run status list (`["queued","provisioning","running","finalizing"]`) is pulled into one shared constant that both this query's `notExists` subquery and `hasNonTerminalRun` (below) reference, so the two can't silently drift apart even though one is a bulk SQL predicate and the other is a per-session check.

### New queue and worker

```ts
// packages/queue/src/index.ts
export const SANDBOX_REAP_QUEUE_NAME = "sandbox-reap";
const sandboxReapQueue = new Queue(SANDBOX_REAP_QUEUE_NAME, { connection: queueConnection });
```

```ts
// apps/worker/src/worker.ts
const SANDBOX_IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h
const SANDBOX_REAP_INTERVAL_MS = 15 * 60 * 1000; // 15min

const sandboxReapWorker = new Worker(
  SANDBOX_REAP_QUEUE_NAME,
  async () => {
    const cutoff = new Date(Date.now() - SANDBOX_IDLE_THRESHOLD_MS);
    const idleSessions = await listIdleSandboxSessions(cutoff);
    for (const session of idleSessions) {
      await enqueueSandboxTeardownJob(session.id);
    }
  },
  { connection: queueConnection },
);

sandboxReapWorker.on("failed", (job, err) => {
  console.error(`Sandbox reap scan failed:`, err);
});

// Registered once at startup; the fixed jobId makes repeat registration on every
// tsx-watch reload a no-op rather than a duplicate schedule (see Design decisions).
await sandboxReapQueue.add("scan", {}, {
  repeat: { every: SANDBOX_REAP_INTERVAL_MS },
  jobId: "sandbox-reap-scan",
});
```

### Teardown worker's new safety check

```ts
// apps/worker/src/worker.ts — sandboxTeardownWorker processor
async (job) => {
  const { sessionId } = job.data;
  const session = await getSession(sessionId);
  if (!session?.sandboxId) return;
  if (await hasNonTerminalRun(sessionId)) { // packages/db/src/repositories/runs.ts
    console.log(`Skipping sandbox teardown for session ${sessionId}: a run is in progress`);
    return;
  }
  await sandboxProvider.destroy(session.sandboxId);
  await clearSessionSandboxId(sessionId);
}
```

## Testing

- **db-integration test for `listIdleSandboxSessions`**: seed sessions covering every boundary — no sandbox (excluded), idle with sandbox and no runs (included), idle with sandbox and only terminal runs (included), idle with sandbox and a non-terminal run (excluded), not-yet-idle with sandbox (excluded) — and assert exactly the right set comes back.
- **worker test for `sandboxReapWorker`**: mock `listIdleSandboxSessions` to return N sessions, assert `enqueueSandboxTeardownJob` is called once per session id and nothing else.
- **worker test for the teardown processor's new safety check**: assert `destroy`/`clearSessionSandboxId` are skipped when a non-terminal run exists for the session, and proceed normally when none does — covering the guard for all three trigger paths, not just idle-reap.

## Risks

- **2 hours is an unmeasured starting default, same as `RETRIEVAL_K`/`SIMILARITY_FLOOR` were before them.** Too short, and active-but-slow review cycles pay re-clones more often than they should; too long, and the failure mode this design fixes takes longer to self-heal. Revisit once there's real usage to look at.
- **The non-terminal-run re-check narrows the race but doesn't eliminate every theoretical window** (a run could still start in the instant between the check and the destroy call). Accepted: closing that last sliver would need a DB-level lock or a transactional claim on the session, disproportionate to a failure mode that, worst case, forces one extra re-clone rather than losing any data — `ensureSandbox` already treats a missing/destroyed sandbox as the normal case to recreate from.
- **This is the first repeatable BullMQ job in the codebase.** If it turns out to interact badly with `tsx watch`'s reload cycle in dev despite the fixed `jobId`, that would be a rough edge worth catching in local testing before this ships.
