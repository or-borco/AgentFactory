export const themePreferences = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof themePreferences)[number];

export type ResolvedTheme = "light" | "dark";

export const defaultThemePreference: ThemePreference = "system";

// Shared with the inline no-flash script in layout.tsx — keep the literal in sync if this changes.
export const themeStorageKey = "agentfactory-theme";
