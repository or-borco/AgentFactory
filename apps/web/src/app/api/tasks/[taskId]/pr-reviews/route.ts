import { NextResponse } from "next/server";
import { getTask, listPrReviewsForTask } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task || task.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(await listPrReviewsForTask(task.id, ctx.orgId));
}
