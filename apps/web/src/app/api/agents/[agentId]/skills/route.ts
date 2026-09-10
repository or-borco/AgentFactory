import { NextResponse } from "next/server";
import { assignSkillToAgent, getAgent, getSkillForOrg, listAgentSkills } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;
  const agent = await getAgent(Number(agentId));
  // 404, not 403: an agent in another org must not be distinguishable from one that isn't there.
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await listAgentSkills(agent.id));
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { agentId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const skillId = Number(body.skillId);
  if (!body.skillId || Number.isNaN(skillId)) {
    return NextResponse.json({ error: "skillId is required" }, { status: 400 });
  }
  // Confirms the skill belongs to this org before assignSkillToAgent (which trusts a bare
  // skillId) ever touches it — otherwise a caller could pin another org's skill onto this agent.
  const skill = await getSkillForOrg(skillId, ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const pin = await assignSkillToAgent(agent.id, skillId);
  if (!pin) return NextResponse.json({ error: "Skill has no published version" }, { status: 400 });
  return NextResponse.json(pin, { status: 201 });
}
