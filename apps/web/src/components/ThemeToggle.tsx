"use client";

import type { ComponentType } from "react";
import type { IconProps } from "@phosphor-icons/react";
import { MonitorIcon, MoonIcon, SunIcon } from "@/lib/icons";
import { useTranslation } from "@/lib/i18n/context";
import { THEME_PREFERENCES, useTheme } from "@/lib/theme/context";
import type { ThemePreference } from "@/lib/theme/constants";
import type { TranslationKey } from "@/lib/i18n/paths";

const ICONS: Record<ThemePreference, ComponentType<IconProps>> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

const LABEL_KEYS: Record<ThemePreference, TranslationKey> = {
  light: "settings.appearance.light",
  dark: "settings.appearance.dark",
  system: "settings.appearance.system",
};

/** Three-way light/dark/system segmented control, backed by ThemeProvider's context. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <div
      role="radiogroup"
      aria-label={t("settings.appearance.title")}
      className="inline-flex gap-1 rounded-[var(--radius-md)] border border-[var(--color-divider)] bg-[var(--color-surface)] p-1"
    >
      {THEME_PREFERENCES.map((option) => {
        const Icon = ICONS[option];
        const active = theme === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(option)}
            className={`flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
              active
                ? "bg-[var(--color-accent-800)] text-[var(--color-accent-200)]"
                : "text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-200)]"
            }`}
          >
            <Icon size={16} weight={active ? "fill" : "regular"} />
            {t(LABEL_KEYS[option])}
          </button>
        );
      })}
    </div>
  );
}
