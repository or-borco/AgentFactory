"use client";

import { createContext, useContext, useState } from "react";
import type { ThemePreference } from "@agentfactory/core";
import { apiFetch } from "@/lib/api-client";
import { useMockBackend } from "@/lib/mock/context";

interface ThemeValue {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

// Seeded from the user row resolved server-side (see the root layout, which also sets the
// initial `data-theme` attribute on <html> so there's no flash of the wrong theme on first
// paint) — this provider's job is just to keep that DOM attribute and the server in sync
// after the user flips the Settings toggle, the same "optimistic update, fetch in the
// background" shape as everything in MockBackendProvider.
export function ThemeProvider({
  initialTheme,
  children,
}: {
  initialTheme: ThemePreference;
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = useState<ThemePreference>(initialTheme);
  const { notify } = useMockBackend();

  const setTheme = (next: ThemePreference) => {
    const previous = theme;
    setThemeState(next);
    document.documentElement.setAttribute("data-theme", next);

    apiFetch("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ themePreference: next }),
    }).catch(() => {
      // Roll back so the UI and the DOM attribute don't lie about what's actually persisted —
      // a refresh would otherwise re-fetch the old value from the server and "snap back" anyway.
      setThemeState(previous);
      document.documentElement.setAttribute("data-theme", previous);
      notify("toast.error");
    });
  };

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
