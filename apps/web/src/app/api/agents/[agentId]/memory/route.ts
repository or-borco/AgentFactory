import { NextResponse } from "next/server";
import { getAgent, readAgentMemoryEntries } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// List-only: creation flows exclusively through the `remember` sandbox tool and the
// memory-retrospective job, never through this API (see the design doc's "no UI add-entry
// button" decision).
export async function GET(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { agentId } = await params;

  const agent = await getAgent(Number(agentId));
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const entries = await readAgentMemoryEntries(ctx.orgId, agent.id);
  return NextResponse.json(entries);
}
