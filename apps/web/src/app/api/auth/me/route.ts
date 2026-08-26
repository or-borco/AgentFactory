import { NextResponse } from "next/server";
import { updateUserThemePreference } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

const VALID_THEME_PREFERENCES = ["dark", "light"];

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ ...ctx.user, orgId: ctx.orgId });
}

// Currently only themePreference is editable here — this isn't a general user-profile patch.
export async function PATCH(request: Request) {
  // Read body before next/headers calls — Next.js dev mode can drop the body stream otherwise.
  const [body, ctx] = await Promise.all([request.json(), requireAuthContext()]);
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!VALID_THEME_PREFERENCES.includes(body.themePreference)) {
    return NextResponse.json({ error: "Invalid theme preference" }, { status: 400 });
  }
  const user = await updateUserThemePreference(ctx.user.id, body.themePreference);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  return NextResponse.json({ ...user, orgId: ctx.orgId });
}
