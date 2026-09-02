import { listIdleSandboxSessions } from "@agentfactory/db";
import { enqueueSandboxTeardownJob } from "@agentfactory/queue";

// A session's sandbox is torn down after this long without activity, even if nothing ever
// explicitly finished or deleted its task (the other two teardown triggers, in apps/web's
// /api/tasks/[taskId] route). Long enough that a developer who steps away mid-task for a couple
// hours doesn't come back to a cold container; see ARCHITECTURE.md's Lifecycle section, which
// this constant is the actual value behind.
export const SANDBOX_IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

// How often apps/worker's sandboxReapWorker re-runs the scan below.
export const SANDBOX_REAP_INTERVAL_MS = 15 * 60 * 1000;

// Finds sessions whose sandbox has sat idle past SANDBOX_IDLE_THRESHOLD_MS and enqueues a
// teardown job for each. listIdleSandboxSessions already excludes sessions with a non-terminal
// run, but that check and this scan are separate queries, not a transaction — the teardown
// worker's own hasNonTerminalRun check immediately before it destroys anything (see worker.ts)
// is the one that actually has to be correct; this is just triage to avoid enqueueing
// obviously-unnecessary jobs.
export async function scanForIdleSandboxes(): Promise<number> {
  const cutoff = new Date(Date.now() - SANDBOX_IDLE_THRESHOLD_MS);
  const idleSessions = await listIdleSandboxSessions(cutoff);
  for (const session of idleSessions) {
    await enqueueSandboxTeardownJob(session.id);
  }
  return idleSessions.length;
}
