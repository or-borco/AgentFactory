import { NextResponse } from "next/server";
import { createSession as createChatSession, listSessions } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const raw = new URL(request.url).searchParams.get("agentId");
  return NextResponse.json(await listSessions(ctx.orgId, raw ? Number(raw) : undefined));
}

export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const session = await createChatSession(ctx.orgId, body.agentId, body.title ?? "New conversation");
  return NextResponse.json(session, { status: 201 });
}
