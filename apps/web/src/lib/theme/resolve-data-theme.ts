import type { ThemePreference } from "@agentfactory/core";

// Only an explicit "light"/"dark" preference can be committed to server-side, before any HTML
// ships, without risking a mismatch against the browser's real prefers-color-scheme — that's what
// avoids the flash. "system" (and no preference at all, e.g. logged out) has nothing to commit
// to, so the caller omits the data-theme attribute entirely and globals.css's
// `@media (prefers-color-scheme)` block takes over, which is correct on first paint by
// construction.
export function resolveDataTheme(theme: ThemePreference | undefined): "light" | "dark" | undefined {
  return theme === "light" || theme === "dark" ? theme : undefined;
}
