"use client";

import type { ThemePreference } from "@agentfactory/core";
import { PageHeader, Badge, Card } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { OrgIcon, GithubIcon, SunIcon, MoonIcon } from "@/lib/icons";
import { ConnectionsList } from "@/components/ConnectionsList";
import { useTheme } from "@/lib/theme/context";

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
  const { theme, setTheme } = useTheme();

  const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof SunIcon }> = [
    { value: "dark", label: t("settings.themeDark"), icon: MoonIcon },
    { value: "light", label: t("settings.themeLight"), icon: SunIcon },
  ];

  return (
    <div className="px-10 pb-16 pt-10">
      <PageHeader title={t("settings.title")} subtitle={orgName} />

      <div className="mt-8 space-y-8">
        <section>
          <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">
            {t("settings.appearanceHeading")}
          </h2>
          <Card className="px-5 py-4">
            <p className="mb-3 text-xs text-[var(--color-neutral-500)]">{t("settings.appearanceDescription")}</p>
            <div className="flex gap-2" role="radiogroup" aria-label={t("settings.appearanceHeading")}>
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={theme === value}
                  aria-label={label}
                  onClick={() => setTheme(value)}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-sm)] border px-3 py-2 text-sm font-medium transition-colors ${
                    theme === value
                      ? "border-[var(--color-accent-600)] bg-[var(--color-accent-900)] text-[var(--color-accent-300)]"
                      : "border-[var(--color-divider)] text-[var(--color-neutral-400)] hover:border-[var(--color-neutral-600)] hover:text-[var(--color-neutral-200)]"
                  }`}
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>
          </Card>
        </section>

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
