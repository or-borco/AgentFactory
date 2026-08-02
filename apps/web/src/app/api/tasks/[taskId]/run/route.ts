// Tenant-isolation gap: see /api/tasks/route.ts for the documented caveat.
import { NextResponse } from "next/server";
import type { Task } from "@agentfactory/core";
import {
  attachTaskSession,
  createMessage,
  createRun,
  createSession,
  getTask,
  touchSessionActivity,
} from "@agentfactory/db";
import { enqueueRunJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

function formatTaskBrief(task: Task): string {
  const lines: string[] = [task.description];

  if (task.acceptanceCriteria.length > 0) {
    lines.push("", "Acceptance criteria:");
    for (const c of task.acceptanceCriteria) {
      lines.push(`- ${c.text}`);
    }
  }

  if (task.area) lines.push("", `Code area: ${task.area}`);
  if (task.codebase) lines.push(`Codebase: ${task.codebase}`);

  return lines.join("\n");
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!task.assigneeAgentId)
    return NextResponse.json({ error: "Task has no assignee" }, { status: 400 });
  if (task.sessionId)
    return NextResponse.json({ error: "Task already has a session" }, { status: 409 });

  const session = await createSession(ctx.orgId, task.assigneeAgentId, task.title);
  const brief = formatTaskBrief(task);
  const userMessage = await createMessage(session.id, "user", brief);
  await touchSessionActivity(session.id);

  const updatedTask = await attachTaskSession(Number(taskId), session.id);

  const run = await createRun(session.id, userMessage.id);
  await enqueueRunJob(run.id);

  return NextResponse.json(
    { task: updatedTask, session, runId: run.id },
    { status: 201 },
  );
}
