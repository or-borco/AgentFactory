import { NextResponse } from "next/server";
import { updateAgent } from "@agentfactory/db";

export async function PATCH(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const body = await request.json();
  const agent = await updateAgent(Number(agentId), body);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(agent);
}
