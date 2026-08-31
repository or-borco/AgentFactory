import { NextResponse } from "next/server";
import { getAgent, getRun, getRunPrompt, getSession } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// The Context tab's data source — fetched lazily on tab open, never polled.
//
// Resolves the run AND proves it belongs to the caller's org (runs → sessions → agents), the
// same walk as the sibling runs/[runId]/evals/route.ts's loadRunForOrg. A cross-org run is
// indistinguishable from a missing one — but here that means { segments: null } with 200, not
// 404, to preserve this route's existing contract below.
//
// A missing run and a run that failed before composing a prompt both return
// { segments: null } with 200: the tab renders "no prompt recorded" for both, and
// reserves non-2xx for transport/auth failures.
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const id = Number(runId);
  // A non-numeric segment is just another "no such run": without this guard NaN reaches
  // Postgres as an invalid integer and the route 500s, contradicting the contract above.
  if (!Number.isInteger(id)) return NextResponse.json({ segments: null });

  const run = await getRun(id);
  if (!run) return NextResponse.json({ segments: null });
  const session = await getSession(run.sessionId);
  if (!session) return NextResponse.json({ segments: null });
  const agent = await getAgent(session.agentId);
  if (!agent || agent.orgId !== ctx.orgId) return NextResponse.json({ segments: null });

  const prompt = await getRunPrompt(id);
  if (!prompt) return NextResponse.json({ segments: null });
  return NextResponse.json(prompt);
}
