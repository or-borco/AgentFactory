import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createConnection } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";
import { getInstallation } from "@/server/github-app";

const STATE_COOKIE = "gh_connect_state";

// This is the GitHub App manifest's `setup_url` — GitHub redirects here after a user
// installs (or updates) the app on their account/org.
export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");
  const state = url.searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (!state || state !== expectedState) {
    return NextResponse.redirect(new URL("/connections?error=state_mismatch", url));
  }
  if (setupAction === "request") {
    // Repo selection is pending approval from a GitHub org owner — no installation yet.
    return NextResponse.redirect(new URL("/connections?error=install_pending", url));
  }
  if (!installationId) {
    return NextResponse.redirect(new URL("/connections?error=missing_installation", url));
  }

  const installation = await getInstallation(Number(installationId));
  await createConnection(ctx.orgId, {
    provider: "github",
    kind: "scm",
    label: installation.account?.login ?? `installation-${installationId}`,
    config: {
      installationId: Number(installationId),
      accountLogin: installation.account?.login,
      accountType: installation.account?.type,
    },
  });

  return NextResponse.redirect(new URL("/connections?connected=github", url));
}
