import { NextResponse } from "next/server";
import { getRunPrompt } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// The Context tab's data source — fetched lazily on tab open, never polled.
// Requires a logged-in user but doesn't yet verify runId belongs to their org — same
// documented tenant-isolation gap as runs/[runId]/route.ts, not new here.
//
// A missing run and a run that failed before composing a prompt both return
// { segments: null } with 200: the tab renders "no prompt recorded" for both, and
// reserves non-2xx for transport/auth failures.
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const prompt = await getRunPrompt(Number(runId));
  if (!prompt) return NextResponse.json({ segments: null });
  return NextResponse.json(prompt);
}
