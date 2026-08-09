// Tenant-isolation gap: requireAuthContext() checks that the caller is logged in and resolves
// their orgId, but does not yet verify resource-level ownership (same documented gap as
// /api/runs/[runId] and /api/sessions/[sessionId]/messages).
import { NextResponse } from "next/server";
import { createTask, listTasks } from "@agentfactory/db";
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
  return NextResponse.json(task, { status: 201 });
}
