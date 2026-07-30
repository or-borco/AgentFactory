import { NextResponse } from "next/server";
import { getRun } from "@agentfactory/db";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = await getRun(Number(runId));
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json(run);
}
