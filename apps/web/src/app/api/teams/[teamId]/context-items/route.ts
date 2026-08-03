import { NextResponse } from "next/server";
import { createTeamContextItem, listTeamContextItems } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(_req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { teamId } = await params;
  return NextResponse.json(await listTeamContextItems(Number(teamId)));
}

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { teamId } = await params;
  const body = await request.json();
  const item = await createTeamContextItem(Number(teamId), body.title, body.sizeBytes ?? 0);
  return NextResponse.json(item, { status: 201 });
}
