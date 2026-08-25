"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  defaultThemePreference,
  themeStorageKey,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

interface ThemeValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function systemPrefersLight(): boolean {
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return systemPrefersLight() ? "light" : "dark";
  return preference;
}

function readStoredPreference(): ThemePreference {
  const stored = window.localStorage.getItem(themeStorageKey);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : defaultThemePreference;
}

// Mirrors the inline script in layout.tsx (which paints the right theme before hydration to
// avoid a flash of the wrong theme). This effect only needs to sync React state to what the
// DOM already shows and keep it updated afterwards.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(defaultThemePreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const initial = readStoredPreference();
    setPreferenceState(initial);
    setResolvedTheme(resolveTheme(initial));
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const listener = () => setResolvedTheme(resolveTheme("system"));
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    window.localStorage.setItem(themeStorageKey, next);
    setResolvedTheme(resolveTheme(next));
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
