import { NextResponse } from "next/server";
import type { Run } from "@agentfactory/core";
import { getAgent, getRun, getSession, listRunContextRetrievals } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// The Context tab's second data source: which team documents each retrieved excerpt came from.
// Like the sibling prompt route it is fetched lazily — and only for a run whose prompt actually
// carries a retrieved_context layer — and never polled.
//
// Unlike the sibling prompt route it IS org-scoped. These rows carry team document titles, which
// are tenant data, so a cross-org run answers 404 rather than leaking a filename. The lookup is
// the same runs → sessions → agents walk the evals route uses.
async function loadRunForOrg(runId: number, orgId: number): Promise<Run | undefined> {
  if (!Number.isInteger(runId)) return undefined;
  const run = await getRun(runId);
  if (!run) return undefined;
  const session = await getSession(run.sessionId);
  if (!session) return undefined;
  const agent = await getAgent(session.agentId);
  if (!agent || agent.orgId !== orgId) return undefined;
  return run;
}

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await loadRunForOrg(Number(runId), ctx.orgId);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // A run with no retrieved layer simply has no rows — an empty array, not a 404. The panel
  // never asks for one of those anyway.
  return NextResponse.json(await listRunContextRetrievals(run.id));
}
