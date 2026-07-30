import { NextResponse } from "next/server";
import { createAgent, listAgents } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listAgents(ctx.orgId));
}

export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const agent = await createAgent(ctx.orgId, body);
  return NextResponse.json(agent, { status: 201 });
}
