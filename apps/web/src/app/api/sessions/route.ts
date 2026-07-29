import { NextResponse } from "next/server";
import { createSession, listSessions } from "@agentfactory/db";
import { ORG_ID } from "@/lib/mock/seed";

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("agentId");
  return NextResponse.json(await listSessions(ORG_ID, raw ? Number(raw) : undefined));
}

export async function POST(request: Request) {
  const body = await request.json();
  const session = await createSession(ORG_ID, body.agentId, body.title ?? "New conversation");
  return NextResponse.json(session, { status: 201 });
}
