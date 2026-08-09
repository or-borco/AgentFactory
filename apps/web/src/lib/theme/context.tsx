"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark";

interface ThemeValue {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const THEME_STORAGE_KEY = "agentfactory-theme";

// Detect the user's preferred theme from the system
function detectPreferredTheme(): Theme {
  if (typeof window === "undefined") return "dark";

  // Check if user has a saved preference
  const saved = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
  if (saved && (saved === "light" || saved === "dark")) {
    return saved;
  }

  // Check system preference
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }

  return "dark";
}

// Apply theme to the document
function applyTheme(theme: Theme) {
  const htmlElement = document.documentElement;
  if (theme === "light") {
    htmlElement.classList.remove("dark");
  } else {
    htmlElement.classList.add("dark");
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");
  const mounted = useRef(false);

  // Initialize theme on mount
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;

    const preferred = detectPreferredTheme();
    setThemeState(preferred);
    applyTheme(preferred);
  }, []);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    applyTheme(newTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
