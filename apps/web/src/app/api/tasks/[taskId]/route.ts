// Tenant-isolation gap: see /api/tasks/route.ts for the documented caveat.
import { NextResponse } from "next/server";
import { deleteTask, getRunsForSession, getTask, updateTask } from "@agentfactory/db";
import { enqueueMemoryRetrospectiveJob, enqueueRepoMapWarmJob, enqueueSandboxTeardownJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";
import type { TaskStatus } from "@agentfactory/core";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("api:tasks:[taskId]");

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);

async function queueRetrospective(orgId: number, agentId: number, sessionId: number): Promise<void> {
  const runs = await getRunsForSession(sessionId);
  const latestRunId = runs.reduce((latest, run) => Math.max(latest, run.id), 0);
  if (latestRunId === 0) return;
  await enqueueMemoryRetrospectiveJob(orgId, agentId, sessionId, latestRunId);
}

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(task);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const body = await req.json();
  const task = await updateTask(Number(taskId), body);

  // A task that's reached a terminal status no longer needs its warm sandbox — tear it down.
  // The worker owns the docker socket, so this only enqueues the job (see the DELETE handler below).
  if (body.status && TERMINAL_TASK_STATUSES.has(task.status) && task.sessionId) {
    await enqueueSandboxTeardownJob(task.sessionId);
  }

  // A completed task is at least as valuable a lesson as a successful one, fires on all three
  // terminal statuses (done, failed, cancelled), unlike the repo-map-warm job below which only
  // fires on "done". Fire-and-forget, same style as the repo-map-warm call: the task update is
  // already committed, so a transient queue failure here must not turn a successful PATCH into
  // an apparent 500.
  if (body.status && TERMINAL_TASK_STATUSES.has(task.status) && task.sessionId && task.assigneeAgentId) {
    queueRetrospective(task.orgId, task.assigneeAgentId, task.sessionId).catch((err) => {
      log.error("Failed to enqueue memory retrospective job", { taskId: task.id, err });
    });
  }

  // A task marked done just merged code (unlike failed/cancelled) — warm the repo map cache so
  // the next task against this codebase doesn't pay the generation cost against a stale commit.
  if (body.status === "done" && task.codebase) {
    enqueueRepoMapWarmJob(task.orgId, task.codebase).catch((err) => {
      log.error("Failed to enqueue repo map warm job", { taskId: task.id, err });
    });
  }

  return NextResponse.json(task);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (task.sessionId) {
    await enqueueSandboxTeardownJob(task.sessionId);
  }

  if (task.sessionId && task.assigneeAgentId) {
    queueRetrospective(task.orgId, task.assigneeAgentId, task.sessionId).catch((err) => {
      log.error("Failed to enqueue memory retrospective job", { taskId: task.id, err });
    });
  }

  await deleteTask(Number(taskId));

  return new NextResponse(null, { status: 204 });
}
