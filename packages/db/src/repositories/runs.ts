import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { ModelSpec, PromptSegment, Run, RunCommitRange, RunPrompt, RunStatus } from "@agentfactory/core";
import { db } from "../client";
import { runs } from "../schema";

// Shared with listIdleSandboxSessions (repositories/sessions.ts) — a session is only safe to
// tear down a sandbox for when none of its runs are in one of these statuses. Kept as one list
// so the two queries can never drift apart on what "still in flight" means.
export const NON_TERMINAL_RUN_STATUSES: RunStatus[] = ["queued", "provisioning", "running", "finalizing"];

// Exactly the columns `toRun` reads — never `select()`. `getRun`/`getRunsForSession` sit on the
// task page's ~1.5s status poll, and prompt_segments is an ~80 KB blob that `toRun` drops on the
// floor; naming the columns keeps it out of the query, off the wire, and out of Node.
type RunRow = Pick<typeof runs.$inferSelect, keyof typeof RUN_COLUMNS>;

const RUN_COLUMNS = {
  id: runs.id,
  sessionId: runs.sessionId,
  status: runs.status,
  triggeringMessageId: runs.triggeringMessageId,
  providerSessionRef: runs.providerSessionRef,
  sandboxId: runs.sandboxId,
  promptHash: runs.promptHash,
  costUsd: runs.costUsd,
  tokensUsed: runs.tokensUsed,
  budgetExceeded: runs.budgetExceeded,
  workspaceSnapshot: runs.workspaceSnapshot,
  commitRange: runs.commitRange,
  model: runs.model,
  createdAt: runs.createdAt,
  finishedAt: runs.finishedAt,
} as const;

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    triggeringMessageId: row.triggeringMessageId ?? undefined,
    providerSessionRef: row.providerSessionRef ?? undefined,
    sandboxId: row.sandboxId ?? undefined,
    promptHash: row.promptHash ?? undefined,
    costUsd: row.costUsd,
    tokensUsed: row.tokensUsed,
    budgetExceeded: row.budgetExceeded ?? undefined,
    workspaceSnapshot: (row.workspaceSnapshot as Record<string, string>) ?? undefined,
    commitRange: (row.commitRange as RunCommitRange) ?? undefined,
    model: row.model ?? undefined,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : undefined,
  };
}

// Safety check before a sandbox teardown (idle-reap, task-done, task-deleted — see
// apps/worker's sandboxTeardownWorker): a session can have a warm sandbox and still be mid-run,
// and destroying the container out from under a running turn would fail it outright.
export async function hasNonTerminalRun(sessionId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), inArray(runs.status, NON_TERMINAL_RUN_STATUSES)))
    .limit(1);
  return row !== undefined;
}

// The Stop button (task-scoped — that's all its call sites have) needs to know which run a
// stop request actually cancels. Non-terminal runs are unique per session in practice (the
// worker never starts a second one while the first is in flight), but this orders by
// createdAt desc anyway rather than assuming that invariant holds forever.
export async function getLatestNonTerminalRun(sessionId: number): Promise<Run | undefined> {
  const [row] = await db
    .select(RUN_COLUMNS)
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), inArray(runs.status, NON_TERMINAL_RUN_STATUSES)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row ? toRun(row) : undefined;
}

// Marks a run cancelled — used by the Stop action alongside enqueueRunCancelJob, which is what
// actually kills the sandbox process running the turn (see apps/worker's runCancelWorker). The
// WHERE clause re-checks non-terminal at the DB level, not just via the caller's own read: a run
// that finishes or fails a moment before this write lands must not be clobbered back to
// "cancelled" by a stop request racing its own completion. Returns undefined (a no-op) when the
// run had already reached a terminal status.
export async function cancelRun(id: number): Promise<Run | undefined> {
  const [row] = await db
    .update(runs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(runs.id, id), inArray(runs.status, NON_TERMINAL_RUN_STATUSES)))
    .returning();
  return row ? toRun(row) : undefined;
}

export async function getRunsForSession(sessionId: number): Promise<Run[]> {
  const rows = await db
    .select(RUN_COLUMNS)
    .from(runs)
    .where(eq(runs.sessionId, sessionId))
    .orderBy(desc(runs.createdAt));
  return rows.map(toRun);
}

export async function updateRunWorkspace(
  id: number,
  workspaceSnapshot: Record<string, string>,
): Promise<void> {
  await db.update(runs).set({ workspaceSnapshot }).where(eq(runs.id, id));
}

// Written once, only when the run's push succeeded. Nothing recomputes this later: the
// session's branch keeps moving as later runs push to it, so the commits belonging to THIS
// run are only knowable at the moment it pushed them.
export async function updateRunCommitRange(id: number, commitRange: RunCommitRange): Promise<void> {
  await db.update(runs).set({ commitRange }).where(eq(runs.id, id));
}

export async function createRun(sessionId: number, triggeringMessageId?: number): Promise<Run> {
  const [row] = await db.insert(runs).values({ sessionId, triggeringMessageId }).returning();
  return toRun(row);
}

export async function getRun(id: number): Promise<Run | undefined> {
  const [row] = await db.select(RUN_COLUMNS).from(runs).where(eq(runs.id, id));
  return row ? toRun(row) : undefined;
}

export async function updateRunStatus(
  id: number,
  status: RunStatus,
  patch?: {
    finishedAt?: Date;
    providerSessionRef?: string;
    sandboxId?: string;
    model?: ModelSpec;
    promptHash?: string;
    promptSegments?: PromptSegment[];
  },
): Promise<Run | undefined> {
  const values: Partial<typeof runs.$inferInsert> = { status };
  if (patch?.finishedAt !== undefined) values.finishedAt = patch.finishedAt;
  if (patch?.providerSessionRef !== undefined) values.providerSessionRef = patch.providerSessionRef;
  if (patch?.sandboxId !== undefined) values.sandboxId = patch.sandboxId;
  if (patch?.model !== undefined) values.model = patch.model;
  if (patch?.promptHash !== undefined) values.promptHash = patch.promptHash;
  if (patch?.promptSegments !== undefined) values.promptSegments = patch.promptSegments;

  const [row] = await db.update(runs).set(values).where(eq(runs.id, id)).returning();
  return row ? toRun(row) : undefined;
}

export interface ResumeCandidate {
  providerSessionRef: string;
  // The sandboxId active when this ref was recorded — undefined for a run that predates this
  // column, which correctly never matches any real sandboxId (see the schema column's comment).
  sandboxId?: string;
}

// Finds the provider session a run *might* resume from: the most recent other run on this
// session that actually completed a provider turn. Postgres stays the source of truth for
// "what should this run resume from" — per ARCHITECTURE.md §1 rule 3, provider session refs
// live on runs, never carried in queue/business logic.
//
// Returning sandboxId alongside the ref (not just the ref) is the fix, not a nice-to-have:
// resume state lives in a specific sandbox container's filesystem, not server-side, so the
// caller must compare this sandboxId against the session's CURRENT one before trusting the ref
// — a mismatch found on some EARLIER run (one recreation ago, or several) is just as fatal to
// resume as one found on this run, and only this comparison catches that; a per-run snapshot of
// "did the sandbox change during this one call" cannot.
export async function getLatestResumeCandidate(
  sessionId: number,
  excludeRunId: number,
): Promise<ResumeCandidate | undefined> {
  const [row] = await db
    .select({ providerSessionRef: runs.providerSessionRef, sandboxId: runs.sandboxId })
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), ne(runs.id, excludeRunId), isNotNull(runs.providerSessionRef)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (!row?.providerSessionRef) return undefined;
  return { providerSessionRef: row.providerSessionRef, sandboxId: row.sandboxId ?? undefined };
}

// The Context tab's read. Selects ONLY the prompt columns — never the full row —
// so this can't grow into another every-column poll payload the way
// getRun/getRunsForSession ship workspaceSnapshot on every status tick.
export async function getRunPrompt(id: number): Promise<RunPrompt | undefined> {
  const [row] = await db
    .select({ promptSegments: runs.promptSegments, promptHash: runs.promptHash })
    .from(runs)
    .where(eq(runs.id, id));
  if (!row?.promptSegments) return undefined;
  // promptHash stays undefined rather than "" when the column is null — an empty
  // string would be indistinguishable from a real (impossible) empty hash, and
  // this feature exists to stop the stored record lying about what was sent.
  return { runId: id, segments: row.promptSegments, promptHash: row.promptHash ?? undefined };
}
