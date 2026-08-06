import { NextResponse } from "next/server";
import { updateTeam } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// Requires a logged-in user but doesn't yet verify teamId belongs to their org — same
// documented tenant-isolation gap as messages/RLS in packages/db/src/schema.ts, not new here.
export async function PATCH(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { teamId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const team = await updateTeam(Number(teamId), body);
  if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
  return NextResponse.json(team);
}
