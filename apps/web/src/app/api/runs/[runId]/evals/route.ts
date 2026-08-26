import { NextResponse } from "next/server";
import type { Run, RunStatus } from "@agentfactory/core";
import { createRunEval, getAgent, getRun, getSession, listEvalsForRun } from "@agentfactory/db";
import { enqueueEvalJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

// Same three terminal statuses RunContextPanel treats as final.
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "failed", "cancelled"]);

// Resolves the run AND proves it belongs to the caller's org (runs → sessions → agents),
// closing — for this route — the tenant-isolation gap documented on the sibling run routes.
// A cross-org run answers 404, indistinguishable from a missing one.
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

export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await loadRunForOrg(Number(runId), ctx.orgId);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (!TERMINAL_STATUSES.has(run.status)) {
    return NextResponse.json({ error: "Run is not finished" }, { status: 409 });
  }

  const runEval = await createRunEval(ctx.orgId, run.id);
  await enqueueEvalJob(runEval.id);
  return NextResponse.json(runEval, { status: 201 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await loadRunForOrg(Number(runId), ctx.orgId);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  return NextResponse.json(await listEvalsForRun(run.id, ctx.orgId));
}
