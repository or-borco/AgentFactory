"use client";

import { PageHeader, Badge, Card } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { OrgIcon, GithubIcon } from "@/lib/icons";
import { ConnectionsList } from "@/components/ConnectionsList";

export function SettingsView({
  orgName,
  orgSlug,
  github,
}: {
  orgName: string | undefined;
  orgSlug: string | undefined;
  github: { configured: boolean; slug?: string };
}) {
  const { t } = useTranslation();

  return (
    <div className="px-10 pb-16 pt-10">
      <PageHeader title={t("settings.title")} subtitle={orgName} />

      <div className="mt-8 space-y-8">
        <section>
          <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">
            {t("settings.organizationHeading")}
          </h2>
          <Card className="flex items-center gap-3 px-5 py-4">
            <div
              className="flex shrink-0 items-center justify-center bg-[var(--color-neutral-800)] text-[var(--color-neutral-500)]"
              style={{ width: 40, height: 40, borderRadius: "var(--radius-md)" }}
            >
              <OrgIcon size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--color-text)]">
                {orgName ?? t("settings.orgFallback")}
              </p>
              <p className="text-xs text-[var(--color-neutral-500)]">{orgSlug ?? t("settings.orgFallback")}</p>
            </div>
          </Card>
        </section>

        <section>
          <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">
            {t("settings.githubAppHeading")}
          </h2>
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
                  {github.configured ? github.slug : t("settings.githubNotConfigured")}
                </p>
                <p className="text-xs text-[var(--color-neutral-500)]">
                  {github.configured ? t("settings.githubConfiguredHelp") : t("settings.githubNotConfiguredHelp")}
                </p>
              </div>
            </div>
            <Badge tone={github.configured ? "success" : "warning"}>
              {github.configured ? t("settings.githubConfiguredBadge") : t("settings.githubNotConfiguredBadge")}
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
