import { NextResponse } from "next/server";
import { mockStore } from "@/server/mock-store";

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("agentId");
  return NextResponse.json(mockStore.listSessions(raw ? Number(raw) : undefined));
}

export async function POST(request: Request) {
  const body = await request.json();
  const session = mockStore.createSession(body.agentId, body.title ?? "New conversation");
  return NextResponse.json(session, { status: 201 });
}
