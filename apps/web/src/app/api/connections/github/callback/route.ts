import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createConnection } from "@agentfactory/db";
import { getScmProvider, ScmInstallIncompleteError } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";

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

  const provider = getScmProvider("github")!;
  try {
    const { label, config } = await provider.completeInstall({
      installationId: installationId ?? "",
      setupAction: setupAction ?? "",
      state,
    });
    await createConnection(ctx.orgId, { provider: "github", kind: "scm", label, config });
  } catch (err) {
    if (err instanceof ScmInstallIncompleteError) {
      const error = err.reason === "pending" ? "install_pending" : "missing_installation";
      return NextResponse.redirect(new URL(`/connections?error=${error}`, url));
    }
    throw err;
  }

  return NextResponse.redirect(new URL("/connections?connected=github", url));
}
