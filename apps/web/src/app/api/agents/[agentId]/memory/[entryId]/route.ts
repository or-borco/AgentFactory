import { NextResponse } from "next/server";
import { MAX_MEMORY_CONTENT_CHARS } from "@agentfactory/core";
import { deleteMemoryEntry, getAgent, updateMemoryEntryContent } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ agentId: string; entryId: string }> },
) {
  // Read body before next/headers calls, since Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { agentId, entryId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (typeof body.content !== "string" || body.content.trim() === "") {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  if (body.content.length > MAX_MEMORY_CONTENT_CHARS) {
    return NextResponse.json(
      { error: `content must be at most ${MAX_MEMORY_CONTENT_CHARS} characters` },
      { status: 400 },
    );
  }

  await updateMemoryEntryContent(ctx.orgId, Number(entryId), body.content, ctx.user.id);
  return new NextResponse(null, { status: 204 });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ agentId: string; entryId: string }> },
) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId, entryId } = await params;

  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await deleteMemoryEntry(ctx.orgId, Number(entryId));
  return new NextResponse(null, { status: 204 });
}
