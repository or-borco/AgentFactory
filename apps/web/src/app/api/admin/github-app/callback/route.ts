import { cookies } from "next/headers";
import { requireAuthContext } from "@/server/auth";

const STATE_COOKIE = "gh_app_register_state";

interface ManifestConversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  pem: string;
  webhook_secret: string;
}

// Completes the manifest flow: exchanges the one-time `code` GitHub sent back for the new
// app's real credentials. This is the only unauthenticated call to GitHub in this flow — the
// manifest-conversion endpoint itself requires no bearer token, per GitHub's API.
export async function GET(request: Request) {
  if (!(await requireAuthContext())) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (!code || !state || state !== expectedState) {
    return new Response("Invalid or expired registration attempt — start over at /api/admin/github-app/register", {
      status: 400,
    });
  }

  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    return new Response(`GitHub app-manifest conversion failed: ${res.status} ${await res.text()}`, { status: 502 });
  }
  const app = (await res.json()) as ManifestConversion;

  return new Response(
    [
      "GitHub App created. Copy these into apps/web/.env.local, then restart the dev server:\n",
      `GITHUB_APP_ID=${app.id}`,
      `GITHUB_APP_SLUG=${app.slug}`,
      `GITHUB_APP_PRIVATE_KEY=${app.pem.replace(/\n/g, "\\n")}`,
      "",
      "(client_id/client_secret/webhook_secret are not needed by this app's install flow and can be discarded.)",
    ].join("\n"),
    { headers: { "Content-Type": "text/plain" } },
  );
}
