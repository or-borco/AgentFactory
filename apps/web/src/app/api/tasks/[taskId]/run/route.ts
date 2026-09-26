// Tenant-isolation gap: see /api/tasks/route.ts for the documented caveat.
import { NextResponse } from "next/server";
import { createRun, getTask, startTaskSession } from "@agentfactory/db";
import { enqueueRunJob } from "@agentfactory/queue";
import { isTaskClosed } from "@agentfactory/core";
import { requireAuthContext } from "@/server/auth";
import { checkTaskSync } from "@/server/task-sync";
import { formatTaskBrief } from "@/server/task-brief";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (isTaskClosed(task.status))
    return NextResponse.json({ error: "Task is closed" }, { status: 409 });
  if (!task.assigneeAgentId)
    return NextResponse.json({ error: "Task has no assignee" }, { status: 400 });
  if (task.sessionId)
    return NextResponse.json({ error: "Task already has a session" }, { status: 409 });

  // No body is the common case (a plain Run click) — don't let an empty payload 500 the route.
  const body = await req.json().catch(() => ({}));

  // A task with no linked issue, or a request that already acknowledged staleness, never calls
  // checkTaskSync at all — zero added latency for the common case. This is a UI-level
  // confirmation before a run is enqueued, not an approval gate on a run already in flight.
  if (task.externalRef && body.acknowledgeStale !== true) {
    const sync = await checkTaskSync(ctx.orgId, task);
    if (sync.stale) {
      return NextResponse.json({ code: "task_stale", latest: sync.latest }, { status: 409 });
    }
  }

  const brief = formatTaskBrief(task);
  const result = await startTaskSession(task.id, ctx.orgId, task.assigneeAgentId, task.title, brief, { origin: "web" });

  if (!result.started) {
    // Lost the race (e.g. a double-click) — same response shape as the pre-check above, just
    // detected inside the transaction instead of before it.
    return NextResponse.json({ error: "Task already has a session" }, { status: 409 });
  }

  const run = await createRun(result.session.id, result.userMessageId);
  await enqueueRunJob(run.id);

  return NextResponse.json(
    { task: result.task, session: result.session, runId: run.id },
    { status: 201 },
  );
}
