import { NextResponse } from "next/server";
import { deleteAgent, updateAgent } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// Requires a logged-in user but doesn't yet verify agentId belongs to their org — same
// documented tenant-isolation gap as messages/RLS in packages/db/src/schema.ts, not new here.
export async function PATCH(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;
  const body = await request.json();
  const agent = await updateAgent(Number(agentId), body);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(agent);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;
  await deleteAgent(Number(agentId));
  return new NextResponse(null, { status: 204 });
}
