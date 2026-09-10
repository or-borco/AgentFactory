import { NextResponse } from "next/server";
import { getSkillForOrg, listSkillAssignments } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const skill = await getSkillForOrg(skillId, ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await listSkillAssignments(skillId));
}
