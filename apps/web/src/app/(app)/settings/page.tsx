import { redirect } from "next/navigation";
import { getOrg } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";
import { SettingsView } from "./SettingsView";

// GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY are only ever read server-side (see
// packages/scm/src/github.ts) — this page only exposes whether they're set, never their
// values, so it's safe to check them directly in a server component.
function githubAppStatus(): { configured: boolean; slug?: string } {
  const configured = Boolean(
    process.env.GITHUB_APP_ID && process.env.GITHUB_APP_SLUG && process.env.GITHUB_APP_PRIVATE_KEY,
  );
  return { configured, slug: process.env.GITHUB_APP_SLUG };
}

export default async function SettingsPage() {
  const ctx = await requireAuthContext();
  if (!ctx) redirect("/login");

  const org = await getOrg(ctx.orgId);
  const github = githubAppStatus();

  return <SettingsView orgName={org?.name} orgSlug={org?.slug} github={github} />;
}
