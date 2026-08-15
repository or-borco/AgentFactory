// Tenant-isolation gap: see /api/tasks/route.ts for the documented caveat.
import { NextResponse } from "next/server";
import { deleteTask, getTask, updateTask } from "@agentfactory/db";
import { enqueueSandboxTeardownJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";
import type { TaskStatus } from "@agentfactory/core";

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);

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
  await deleteTask(Number(taskId));

  return new NextResponse(null, { status: 204 });
}
