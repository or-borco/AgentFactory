import { NextResponse } from "next/server";
import { getRun } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// Requires a logged-in user but doesn't yet verify runId belongs to their org — same
// documented tenant-isolation gap as messages/RLS in packages/db/src/schema.ts, not new here.
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const run = await getRun(Number(runId));
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(run);
}
