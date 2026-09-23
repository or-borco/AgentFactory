import { NextResponse } from "next/server";
import { getAgent, listMemoryEntryWrites, memoryEntryBelongsToAgent } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string; entryId: string }> },
) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId, entryId } = await params;

  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await memoryEntryBelongsToAgent(ctx.orgId, agent.id, Number(entryId)))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(await listMemoryEntryWrites(ctx.orgId, Number(entryId)));
}
