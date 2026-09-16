import { NextResponse } from "next/server";
import { deleteAgent, getAgent, updateAgent } from "@agentfactory/db";
import { isValidAgentRole, isValidModelId, isValidOverflowPolicy } from "@agentfactory/core";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("api:agents:[agentId]");

// Requires a logged-in user but doesn't yet verify agentId belongs to their org — same
// documented tenant-isolation gap as messages/RLS in packages/db/src/schema.ts, not new here.
export async function PATCH(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { agentId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (body.model !== undefined && !isValidModelId(body.model)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  if (body.role !== undefined && !isValidAgentRole(body.role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  if (body.onContextOverflow !== undefined && !isValidOverflowPolicy(body.onContextOverflow)) {
    return NextResponse.json({ error: "Invalid onContextOverflow value" }, { status: 400 });
  }
  const agent = await updateAgent(Number(agentId), body);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (typeof body.defaultCodebase === "string" && body.defaultCodebase) {
    // Fire-and-forget: the agent row is already committed, so a transient queue/Redis failure
    // here must not turn a successful update into an apparent 500 for the client.
    enqueueRepoMapWarmJob(agent.orgId, body.defaultCodebase).catch((err) => {
      log.error("Failed to enqueue repo map warm job", { agentId: agent.id, err });
    });
  }
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
