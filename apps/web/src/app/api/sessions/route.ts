import { NextResponse } from "next/server";
import { mockStore } from "@/server/mock-store";

export async function GET(request: Request) {
  const agentId = new URL(request.url).searchParams.get("agentId") ?? undefined;
  return NextResponse.json(mockStore.listSessions(agentId));
}

export async function POST(request: Request) {
  const body = await request.json();
  const session = mockStore.createSession(body.agentId, body.title ?? "New conversation");
  return NextResponse.json(session, { status: 201 });
}
