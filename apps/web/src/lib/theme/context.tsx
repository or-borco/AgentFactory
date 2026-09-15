"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "agentfactory-theme";

interface ThemeValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function readCurrentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Renders "dark" for both the server pass and the initial client hydration pass, then syncs
  // to whatever the blocking inline script (see root layout) already applied to <html> before
  // paint. Mirrors I18nProvider's detectLocale pattern: reading real state on mount rather than
  // during render keeps the two passes identical, so there's no hydration mismatch.
  const [theme, setTheme] = useState<Theme>("dark");
  const synced = useRef(false);

  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    setTheme(readCurrentTheme());
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
