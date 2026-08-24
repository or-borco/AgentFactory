import { NextResponse } from "next/server";
import { updateTeam } from "@agentfactory/db";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

// Requires a logged-in user but doesn't yet verify teamId belongs to their org — same
// documented tenant-isolation gap as messages/RLS in packages/db/src/schema.ts, not new here.
export async function PATCH(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx, { teamId }] = await Promise.all([request.json(), requireAuthContext(), params]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const team = await updateTeam(Number(teamId), body);
  if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
  if (typeof body.defaultCodebase === "string" && body.defaultCodebase) {
    // Fire-and-forget: the team row is already committed, so a transient queue/Redis failure
    // here must not turn a successful update into an apparent 500 for the client.
    enqueueRepoMapWarmJob(team.orgId, body.defaultCodebase).catch((err) => {
      console.error("Failed to enqueue repo map warm job:", err);
    });
  }
  return NextResponse.json(team);
}
