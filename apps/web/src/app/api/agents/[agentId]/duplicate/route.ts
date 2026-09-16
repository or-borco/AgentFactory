import { NextResponse } from "next/server";
import { duplicateAgent, getAgent, getTeamForOrg } from "@agentfactory/db";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("api:agents:[agentId]:duplicate");

// Clones an agent (prompt, model, tool policy, connections, default codebase, pinned skills —
// everything) into another team, prefixing the copy's name with "Copy of ". Both the source
// agent and the target team must belong to the caller's org — 404, not 403, on either mismatch,
// same reasoning as the sibling agent routes: an org's own resources must not be distinguishable
// from ones that don't exist.
export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { agentId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const teamId = Number(body.teamId);
  if (!body.teamId || Number.isNaN(teamId)) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }
  const team = await getTeamForOrg(teamId, ctx.orgId);
  if (!team) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const duplicate = await duplicateAgent(agent.id, team.id);
  if (!duplicate) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (duplicate.defaultCodebase) {
    // Fire-and-forget, exactly like agent creation: the duplicate is already committed, so a
    // transient queue/Redis failure here must not turn a successful duplication into a 500.
    enqueueRepoMapWarmJob(duplicate.orgId, duplicate.defaultCodebase).catch((err) => {
      log.error("Failed to enqueue repo map warm job", { agentId: duplicate.id, err });
    });
  }

  return NextResponse.json(duplicate, { status: 201 });
}
