import { NextResponse } from "next/server";
import { decomposeSkillMarkdown, getDraftForSkill, getSkillForOrg, getSkillVersionMarkdown, updateDraft } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// The skill detail page's edit form needs the draft's actual instructions text to pre-fill
// with, not just the SkillVersion row (which only carries the body's sha256, not its content) —
// this is the "small helper route" the repositories' own comments anticipate Task 3 adding.
export async function GET(_request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const skill = await getSkillForOrg(skillId, ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const draft = await getDraftForSkill(skillId);
  if (!draft) return NextResponse.json({ error: "No draft" }, { status: 404 });
  const markdown = await getSkillVersionMarkdown(ctx.orgId, draft);
  const instructions = markdown ? decomposeSkillMarkdown(markdown).instructions : "";
  return NextResponse.json({ version: draft, instructions });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { skillId: skillIdParam }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number(skillIdParam);
  const skill = await getSkillForOrg(skillId, ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const draft = await getDraftForSkill(skillId);
  if (!draft) return NextResponse.json({ error: "No draft — create one first" }, { status: 404 });
  const updated = await updateDraft(draft.id, ctx.orgId, {
    name: typeof body.name === "string" ? body.name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
  });
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(updated);
}
