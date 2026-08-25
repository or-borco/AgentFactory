"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type ThemeSetting = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "af-theme";

interface ThemeValue {
  /** The user's stored preference, including "system". */
  theme: ThemeSetting;
  /** The actual theme applied to the page ("system" resolved to light/dark). */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeSetting) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function prefersLight(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches;
}

function resolveTheme(theme: ThemeSetting): ResolvedTheme {
  return theme === "system" ? (prefersLight() ? "light" : "dark") : theme;
}

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", resolved);
}

function readStoredTheme(): ThemeSetting {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Matches the "dark" default already baked into globals.css until the real
  // preference (set synchronously pre-hydration by the inline theme script) is read.
  const [theme, setThemeState] = useState<ThemeSetting>("dark");
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    setThemeState(readStoredTheme());
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme(resolveTheme("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemeSetting) => {
    setThemeState(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(resolveTheme(next));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme: resolveTheme(theme), setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
