// Tenant-isolation gap: requireAuthContext() checks that the caller is logged in and resolves
// their orgId, but does not yet verify resource-level ownership (same documented gap as
// /api/runs/[runId] and /api/sessions/[sessionId]/messages).
import { NextResponse } from "next/server";
import { createTask, listTasks } from "@agentfactory/db";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { isValidModelId } from "@agentfactory/core";
import { requireAuthContext } from "@/server/auth";

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listTasks(ctx.orgId));
}

export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  if (body.model !== undefined && !isValidModelId(body.model?.id)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  const task = await createTask(ctx.orgId, ctx.user.id, {
    title: body.title,
    description: body.description ?? "",
    acceptanceCriteria: body.acceptanceCriteria ?? [],
    assigneeAgentId: body.assigneeAgentId ?? undefined,
    area: body.area ?? undefined,
    codebase: body.codebase ?? undefined,
    model: body.model ?? undefined,
  });

  // Creating a task with a codebase is the most common way a repository first becomes relevant,
  // and it was the one entry point that did not warm the map — PATCH /api/tasks/[taskId] and all
  // four agent/team routes already do this. On task T-070 the map for the task's codebase was
  // generated 54 seconds into an 8-minute run and never read, because nothing scheduled it until
  // the run itself missed the cache.
  //
  // Fire-and-forget with the same .catch as the other call sites: a queue outage must not turn a
  // successful task creation into a 500, and a missed warm only means the next run pays the
  // generation cost, exactly as it does today.
  if (task.codebase) {
    enqueueRepoMapWarmJob(task.orgId, task.codebase).catch((err) => {
      console.error(`Failed to enqueue repo map warm job for task ${task.id}:`, err);
    });
  }

  return NextResponse.json(task, { status: 201 });
}
