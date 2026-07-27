import { NextResponse } from "next/server";
import { mockStore } from "@/server/mock-store";

export async function GET() {
  return NextResponse.json(mockStore.listAgents());
}

export async function POST(request: Request) {
  const body = await request.json();
  const agent = mockStore.createAgent(body);
  return NextResponse.json(agent, { status: 201 });
}
