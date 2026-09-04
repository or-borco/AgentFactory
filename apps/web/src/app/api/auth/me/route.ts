import { NextResponse } from "next/server";
import { updateUserPreferences } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

const THEME_VALUES = ["light", "dark", "system"] as const;

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ...ctx.user, orgId: ctx.orgId });
}

// Extends the existing "current user" resource rather than a new route — PATCH here means
// "update the current user's preferences," matching GET's "read the current user."
export async function PATCH(request: Request) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx] = await Promise.all([request.json(), requireAuthContext()]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!THEME_VALUES.includes(body.theme)) {
    return NextResponse.json({ error: "Invalid theme" }, { status: 400 });
  }

  const user = await updateUserPreferences(ctx.user.id, { theme: body.theme });
  return NextResponse.json({ ...user, orgId: ctx.orgId });
}
