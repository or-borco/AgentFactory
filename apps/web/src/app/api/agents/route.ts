import { NextResponse } from "next/server";
import { createAgent, listAgents } from "@agentfactory/db";
import { ORG_ID } from "@/lib/mock/seed";

export async function GET() {
  return NextResponse.json(await listAgents(ORG_ID));
}

export async function POST(request: Request) {
  const body = await request.json();
  const agent = await createAgent(ORG_ID, body);
  return NextResponse.json(agent, { status: 201 });
}
