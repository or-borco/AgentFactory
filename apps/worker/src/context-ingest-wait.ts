import { countPendingTaskContextItems, countPendingTeamContextItems } from "@agentfactory/db";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("context-ingest-wait");

// Mirrors repo-map.ts's CACHE_POLL_TIMEOUT_MS / CACHE_POLL_INTERVAL_MS for the same race shape:
// one part of a run's context (here, an uploaded document's chunks) may not have finished
// becoming ready by the time the run needs to read it.
export const INGEST_POLL_TIMEOUT_MS = 20_000;
export const INGEST_POLL_INTERVAL_MS = 1_000;
// Without a recency cutoff, a context item permanently stuck at "indexing" (a worker crash after
// retries are exhausted) would make every future run against that team/task eat the full poll
// timeout, forever. Restricting the check to items created in the last 5 minutes means a stuck
// item stops being polled for shortly after it gets stuck, while comfortably covering every
// realistic ingest job (repo-map generation, a related race, tops out around 38s elsewhere in
// this codebase). This is a mitigation for run latency, not a fix for the stuck row itself — see
// AgentFactory#120 for that class of problem.
export const INGEST_RECENCY_WINDOW_MS = 5 * 60_000;

export interface ContextIngestScope {
  teamId?: number;
  taskId?: number;
}

async function countPending(scope: ContextIngestScope, since: Date): Promise<number> {
  const [teamPending, taskPending] = await Promise.all([
    scope.teamId ? countPendingTeamContextItems(scope.teamId, since) : Promise.resolve(0),
    scope.taskId ? countPendingTaskContextItems(scope.taskId, since) : Promise.resolve(0),
  ]);
  return teamPending + taskPending;
}

// Called from the run pipeline right before retrieveContext, once team/task are resolved. A run
// that starts (via the Run button, a chat message, or a re-run) while an attached document is
// still being chunked and embedded would otherwise see zero, a partial, or — across a redelivered
// ingest job's delete-then-rewrite — even fewer chunks than an earlier run saw (AgentFactory#150).
// This waits briefly for recently-created pending/indexing items to clear, then always proceeds:
// retrieveContext itself is unchanged and still just counts chunk rows at query time, exactly as
// before.
//
// Never throws: any failure here (e.g. a DB error) falls back to proceeding immediately, exactly
// as if the wait were skipped, matching ensureRepoMap's and retrieveContext's own fail-soft
// contracts.
export async function waitForPendingContextIngest(
  scope: ContextIngestScope,
  deps?: { sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  try {
    if (!scope.teamId && !scope.taskId) return;

    const since = new Date(Date.now() - INGEST_RECENCY_WINDOW_MS);
    const pending = await countPending(scope, since);
    // The overwhelmingly common path, and it must stay free: a run whose documents (if any) are
    // already indexed pays nothing for the poll below.
    if (pending === 0) return;

    // Counted attempts rather than a wall-clock deadline, exactly like ensureRepoMap: the loop is
    // then deterministic, and a test can inject an instant sleep without spinning for 20 real
    // seconds.
    const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const attempts = Math.floor(INGEST_POLL_TIMEOUT_MS / INGEST_POLL_INTERVAL_MS);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await sleep(INGEST_POLL_INTERVAL_MS);
      const stillPending = await countPending(scope, since);
      if (stillPending === 0) {
        log.info("Pending context ingest cleared while polling", {
          ...scope,
          pollMs: attempt * INGEST_POLL_INTERVAL_MS,
        });
        return;
      }
    }
    log.info("Context ingest did not finish within poll timeout; proceeding without waiting further", {
      ...scope,
      timeoutMs: INGEST_POLL_TIMEOUT_MS,
    });
  } catch (err) {
    log.error("Context ingest wait failed", { ...scope, err });
  }
}
