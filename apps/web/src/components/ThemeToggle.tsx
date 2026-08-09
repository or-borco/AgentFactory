"use client";

import { useTheme } from "@/lib/theme";
import { Button } from "@agentfactory/shared";
import { Moon, Sun } from "@phosphor-icons/react";

/**
 * ThemeToggle Component
 *
 * A simple button component that toggles between light and dark modes.
 * Can be placed in a header, navigation, or settings panel.
 *
 * Usage:
 * ```tsx
 * <ThemeToggle />
 * ```
 */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <Button
      onClick={toggleTheme}
      variant="secondary"
      title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </Button>
  );
}
