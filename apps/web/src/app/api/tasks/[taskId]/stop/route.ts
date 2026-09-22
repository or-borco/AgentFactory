// Tenant-isolation gap: see /api/tasks/route.ts for the documented caveat.
import { NextResponse } from "next/server";
import { cancelRun, getLatestNonTerminalRun, getTask } from "@agentfactory/db";
import { enqueueRunCancelJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

// Backs the Stop button (TaskRowActions and the task detail page). Cancelling here means two
// things, both of which have to happen for the agent to actually stop rather than merely look
// stopped: mark the in-flight run "cancelled" in Postgres (what the UI polls), and enqueue a job
// the worker uses to kill that run's sandbox — Docker is only reachable from the worker process,
// so this route can't touch it directly (same reason DELETE and mark-done enqueue a teardown job
// instead). No non-terminal run (e.g. a double-click, or the run just finished on its own) is a
// harmless no-op, not an error.
//
// Best-effort, not a cooperative cancellation point: if the stop request lands while the worker
// is still provisioning the sandbox (before session.sandboxId is recorded), runCancelWorker has
// nothing to destroy yet and the run proceeds — there's no polling loop anywhere in the run job
// for it to check `status === "cancelled"` against. In practice this only matters for the brief
// provisioning window; once the agent's turn is actually executing (the vast majority of a run's
// wall-clock time), destroying the sandbox is what kills it.
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!task.sessionId) return NextResponse.json({ error: "Task has no active session" }, { status: 400 });

  const run = await getLatestNonTerminalRun(task.sessionId);
  if (run) {
    const cancelled = await cancelRun(run.id);
    if (cancelled) await enqueueRunCancelJob(task.sessionId);
  }

  return NextResponse.json(task);
}
