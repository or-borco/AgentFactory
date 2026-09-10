import { NextResponse } from "next/server";
import { deleteSkillForOrg, getSkillForOrg, getSkillVersionsForSkill } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const skill = await getSkillForOrg(skillId, ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const versions = await getSkillVersionsForSkill(skillId);
  return NextResponse.json({ skill, versions });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const skill = await getSkillForOrg(skillId, ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const deleted = await deleteSkillForOrg(skillId, ctx.orgId);
  if (!deleted) {
    return NextResponse.json({ error: "Skill is assigned to an agent; unassign it first" }, { status: 409 });
  }
  return new NextResponse(null, { status: 204 });
}
