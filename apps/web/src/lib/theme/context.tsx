"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  isThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "./constants";

interface ThemeContextValue {
  /** The user's stored preference — may be "system". */
  theme: ThemePreference;
  /** The actual "light" | "dark" appearance currently applied to the document. */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredTheme(): ThemePreference | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : null;
  } catch {
    // localStorage can throw in private-browsing/blocked-storage contexts.
    return null;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // "dark" matches the default values in :root, so there's no mismatch before the effect
  // below reconciles this with localStorage/system preference on mount.
  const [theme, setThemeState] = useState<ThemePreference>("dark");
  const [systemPrefersDark, setSystemPrefersDark] = useState(true);

  useEffect(() => {
    const stored = readStoredTheme();
    if (stored) setThemeState(stored);
    setSystemPrefersDark(getSystemPrefersDark());

    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme = useMemo(() => resolveTheme(theme, systemPrefersDark), [theme, systemPrefersDark]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore write failures (private browsing/blocked storage) — theme still applies for
      // this session via React state, it just won't persist across reloads.
    }
  }, []);

  const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

export { THEME_PREFERENCES } from "./constants";
export type { ResolvedTheme, ThemePreference } from "./constants";
