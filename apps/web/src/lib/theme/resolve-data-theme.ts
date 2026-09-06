import type { ThemePreference } from "@agentfactory/core";

// The only two values worth committing to in the initial SSR markup: "system" (or no
// preference at all, e.g. a logged-out request) has nothing server-known to stamp, so the
// `<html>` element gets no `data-theme` attribute and globals.css's `@media (prefers-color-scheme)`
// block decides on first paint instead. That's what keeps this pure and side-effect free enough
// to unit test without touching the DB or cookies.
export type DataTheme = "light" | "dark" | undefined;

export function resolveDataTheme(theme: ThemePreference | undefined): DataTheme {
  return theme === "light" || theme === "dark" ? theme : undefined;
}
