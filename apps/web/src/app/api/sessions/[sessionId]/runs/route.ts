import { NextResponse } from "next/server";
import { getRunsForSession } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { sessionId } = await params;
  const runs = await getRunsForSession(Number(sessionId));
  return NextResponse.json(runs);
}
