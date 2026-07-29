import { NextResponse } from "next/server";
import { updateTeam } from "@agentfactory/db";

export async function PATCH(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const body = await request.json();
  const team = await updateTeam(teamId, body);
  if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
  return NextResponse.json(team);
}
