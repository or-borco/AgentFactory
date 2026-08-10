import { redirect } from "next/navigation";
import { PageHeader, Badge, Card } from "@agentfactory/shared";
import { getOrg } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";
import { ConnectionsList } from "@/components/ConnectionsList";
import { OrgIcon, GithubIcon } from "@/lib/icons";

// GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY are only ever read server-side (see
// apps/web/src/server/github-app.ts) — this page only exposes whether they're set, never their
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

  return (
    <div className="px-10 pb-16 pt-10">
      <PageHeader title="Settings" subtitle={org ? org.name : undefined} />

      <div className="mt-8 space-y-8">
        <section>
          <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">Organization</h2>
          <Card className="flex items-center gap-3 px-5 py-4">
            <div
              className="flex shrink-0 items-center justify-center bg-[var(--color-neutral-800)] text-[var(--color-neutral-500)]"
              style={{ width: 40, height: 40, borderRadius: "var(--radius-md)" }}
            >
              <OrgIcon size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--color-text)]">{org?.name ?? "—"}</p>
              <p className="text-xs text-[var(--color-neutral-500)]">{org?.slug ?? "—"}</p>
            </div>
          </Card>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">GitHub App</h2>
          <Card className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-3">
              <div
                className="flex shrink-0 items-center justify-center bg-[var(--color-neutral-800)] text-[var(--color-neutral-500)]"
                style={{ width: 40, height: 40, borderRadius: "var(--radius-md)" }}
              >
                <GithubIcon size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--color-text)]">
                  {github.configured ? github.slug : "Not configured"}
                </p>
                <p className="text-xs text-[var(--color-neutral-500)]">
                  {github.configured
                    ? "The platform GitHub App is registered and ready for connections below."
                    : "Register the platform GitHub App before connecting repositories."}
                </p>
              </div>
            </div>
            <Badge tone={github.configured ? "success" : "warning"}>
              {github.configured ? "Configured" : "Not configured"}
            </Badge>
          </Card>
        </section>

        <section>
          <ConnectionsList />
        </section>
      </div>
    </div>
  );
}
