import { NextResponse } from "next/server";
import { createSkillWithDraft, listSkillsForOrg } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listSkillsForOrg(ctx.orgId));
}

export async function POST(request: Request) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx] = await Promise.all([request.json(), requireAuthContext()]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (
    typeof body.name !== "string" ||
    !body.name.trim() ||
    typeof body.instructions !== "string" ||
    !body.instructions.trim()
  ) {
    return NextResponse.json({ error: "name and instructions are required" }, { status: 400 });
  }
  const { skill, draft } = await createSkillWithDraft(ctx.orgId, {
    name: body.name,
    description: typeof body.description === "string" ? body.description : "",
    instructions: body.instructions,
    createdBy: ctx.user.id,
  });
  return NextResponse.json({ skill, draft }, { status: 201 });
}
