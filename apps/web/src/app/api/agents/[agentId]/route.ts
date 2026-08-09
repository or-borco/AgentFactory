import { NextResponse } from "next/server";
import { deleteAgent, getAgent, updateAgent } from "@agentfactory/db";
import { isValidModelId } from "@agentfactory/core";
import { requireAuthContext } from "@/server/auth";

// Requires a logged-in user but doesn't yet verify agentId belongs to their org — same
// documented tenant-isolation gap as messages/RLS in packages/db/src/schema.ts, not new here.
export async function PATCH(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;
  const body = await request.json();
  if (body.model !== undefined && !isValidModelId(body.model)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  const agent = await updateAgent(Number(agentId), body);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(agent);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;
  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await deleteAgent(Number(agentId));
  return new NextResponse(null, { status: 204 });
}
