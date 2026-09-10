import { NextResponse } from "next/server";
import {
  createDraftFromPublished,
  decomposeSkillMarkdown,
  getSkillForOrg,
  getSkillVersion,
  getSkillVersionMarkdown,
  updateDraft,
} from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// Starts a new draft branched off the currently published version.
export async function POST(_request: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const skillId = Number((await params).skillId);
  const skill = await getSkillForOrg(skillId, ctx.orgId);
  if (!skill) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const draft = await createDraftFromPublished(skillId, ctx.orgId, ctx.user.id);
  if (!draft) {
    return NextResponse.json({ error: "A draft already exists, or there is nothing published yet" }, { status: 409 });
  }

  // createDraftFromPublished leaves the new draft's instructions blank (it only has the body's
  // sha256 to work from, not the decomposed text) — re-fetch the published markdown here and
  // seed the draft with it so the edit form opens showing the current instructions to build on,
  // not an empty body.
  if (skill.currentVersionId) {
    const published = await getSkillVersion(skill.currentVersionId);
    const publishedMarkdown = published ? await getSkillVersionMarkdown(ctx.orgId, published) : undefined;
    if (publishedMarkdown) {
      const { instructions } = decomposeSkillMarkdown(publishedMarkdown);
      const seeded = await updateDraft(draft.id, ctx.orgId, { instructions });
      if (seeded) return NextResponse.json(seeded, { status: 201 });
    }
  }
  return NextResponse.json(draft, { status: 201 });
}
