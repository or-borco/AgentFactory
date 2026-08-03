import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { requireAuthContext } from "@/server/auth";

const STATE_COOKIE = "gh_connect_state";

export async function GET() {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return NextResponse.json({ error: "GITHUB_APP_SLUG is not set" }, { status: 500 });

  const state = randomBytes(16).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  // GitHub's own install UI handles the repo picker; we only need to route the user there
  // and verify `state` on the way back.
  return NextResponse.redirect(`https://github.com/apps/${slug}/installations/new?state=${state}`);
}
