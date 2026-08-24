import { NextResponse } from "next/server";
import { createAgent, listAgents } from "@agentfactory/db";
import { isValidModelId, isValidOverflowPolicy } from "@agentfactory/core";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
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
  if (body.model !== undefined && !isValidModelId(body.model)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  if (body.onContextOverflow !== undefined && !isValidOverflowPolicy(body.onContextOverflow)) {
    return NextResponse.json({ error: "Invalid onContextOverflow value" }, { status: 400 });
  }
  const agent = await createAgent(ctx.orgId, body);
  if (agent.defaultCodebase) {
    await enqueueRepoMapWarmJob(ctx.orgId, agent.defaultCodebase);
  }
  return NextResponse.json(agent, { status: 201 });
}
