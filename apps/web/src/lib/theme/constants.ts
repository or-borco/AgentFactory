// Shared between the ThemeProvider (client-side React state) and the inline
// `beforeInteractive` script in the root layout (plain JS, no imports allowed there since
// it runs as a raw string before any bundle executes) — keep both in sync if this changes.
export const THEME_STORAGE_KEY = "agentfactory-theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

/** Pure function so it can be unit-tested without touching the DOM or localStorage. */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}
