import { NextResponse } from "next/server";
import { deleteTaskContextItemForOrg, getTask, getTaskContextItemForOrg } from "@agentfactory/db";
import { isTaskClosed } from "@agentfactory/core";
import { requireAuthContext } from "@/server/auth";

export async function DELETE(_req: Request, { params }: { params: Promise<{ taskId: string; itemId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { itemId } = await params;
  const item = await getTaskContextItemForOrg(Number(itemId), ctx.orgId);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const task = await getTask(item.taskId);
  if (task && isTaskClosed(task.status)) {
    return NextResponse.json({ error: "Task is closed" }, { status: 409 });
  }
  const deleted = await deleteTaskContextItemForOrg(item.id, ctx.orgId);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
