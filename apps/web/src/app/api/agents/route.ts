import { NextResponse } from "next/server";
import { createAgent, listAgents } from "@agentfactory/db";
import { isValidModelId, isValidOverflowPolicy } from "@agentfactory/core";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("api:agents");

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
    // Fire-and-forget: the agent row is already committed, so a transient queue/Redis failure
    // here must not turn a successful creation into an apparent 500 for the client.
    enqueueRepoMapWarmJob(ctx.orgId, agent.defaultCodebase).catch((err) => {
      log.error("Failed to enqueue repo map warm job", { agentId: agent.id, err });
    });
  }
  return NextResponse.json(agent, { status: 201 });
}
