import { NextResponse } from "next/server";
import { createTeam, listTeams } from "@agentfactory/db";
import { ORG_ID } from "@/lib/mock/seed";

export async function GET() {
  return NextResponse.json(await listTeams(ORG_ID));
}

export async function POST(request: Request) {
  const body = await request.json();
  const team = await createTeam(ORG_ID, body.name, body.description ?? "");
  return NextResponse.json(team, { status: 201 });
}
