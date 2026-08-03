import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { requireAuthContext } from "@/server/auth";

const STATE_COOKIE = "gh_app_register_state";

// One-time, admin-only route: registers the platform's GitHub App via the manifest flow so
// nobody has to hand-fill GitHub's OAuth-App-style creation form. GitHub's manifest flow
// requires a POSTed form (not a redirect), so this returns a tiny page that auto-submits one.
export async function GET(request: Request) {
  if (!(await requireAuthContext())) return new Response("Unauthorized", { status: 401 });

  const origin = new URL(request.url).origin;
  const state = randomBytes(16).toString("hex");

  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  const manifest = {
    name: `AgentFactory (${origin})`,
    url: origin,
    redirect_url: `${origin}/api/admin/github-app/callback`,
    setup_url: `${origin}/api/connections/github/callback`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    default_events: [],
  };

  const html = `<!doctype html>
<html>
  <body onload="document.forms[0].submit()">
    <form method="post" action="https://github.com/settings/apps/new?state=${state}">
      <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}' />
      <button type="submit">Create GitHub App</button>
    </form>
  </body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}
