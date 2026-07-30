import { NextResponse } from "next/server";
import { createTeam, listTeams } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listTeams(ctx.orgId));
}

export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const team = await createTeam(ctx.orgId, body.name, body.description ?? "");
  return NextResponse.json(team, { status: 201 });
}
