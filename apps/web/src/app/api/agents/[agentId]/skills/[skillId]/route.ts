import { NextResponse } from "next/server";
import { getAgent, getSkillForOrg, unassignSkillFromAgent, updateAgentSkillVersion } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ agentId: string; skillId: string }> },
) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { agentId, skillId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const skill = await getSkillForOrg(Number(skillId), ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const skillVersionId = Number(body.skillVersionId);
  if (!body.skillVersionId || Number.isNaN(skillVersionId)) {
    return NextResponse.json({ error: "skillVersionId is required" }, { status: 400 });
  }
  // updateAgentSkillVersion re-verifies skillVersionId is both published and a version of this
  // exact skill — that check can't be skipped here, an "upgrade" is the one place a caller could
  // otherwise silently pin an unpublished draft.
  const updated = await updateAgentSkillVersion(agent.id, skill.id, skillVersionId);
  if (!updated) return NextResponse.json({ error: "Not a published version of this skill" }, { status: 400 });
  return NextResponse.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ agentId: string; skillId: string }> },
) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId, skillId } = await params;
  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const skill = await getSkillForOrg(Number(skillId), ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const removed = await unassignSkillFromAgent(agent.id, skill.id);
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
