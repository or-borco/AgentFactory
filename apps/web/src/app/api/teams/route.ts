import { NextResponse } from "next/server";
import { mockStore } from "@/server/mock-store";

export async function GET() {
  return NextResponse.json(mockStore.listTeams());
}

export async function POST(request: Request) {
  const body = await request.json();
  const team = mockStore.createTeam(body.name, body.description ?? "");
  return NextResponse.json(team, { status: 201 });
}
