import type { TranslationKey } from "./i18n/paths";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export function relativeTime(iso: string, t: Translate): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return t("relativeTime.justNow");
  if (minutes < 60) return t(minutes === 1 ? "relativeTime.minuteOne" : "relativeTime.minuteOther", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t(hours === 1 ? "relativeTime.hourOne" : "relativeTime.hourOther", { count: hours });
  const days = Math.round(hours / 24);
  return t(days === 1 ? "relativeTime.dayOne" : "relativeTime.dayOther", { count: days });
}
