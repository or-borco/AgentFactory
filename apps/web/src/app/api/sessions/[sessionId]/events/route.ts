import { NextResponse } from "next/server";
import { listEventsForSession } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { sessionId } = await params;
  return NextResponse.json(await listEventsForSession(Number(sessionId)));
}
