import { describe, expect, it, vi } from "vitest";
import type { ThemePreference, User } from "@agentfactory/core";

// next/font/google fetches real font manifests over the network at module init; it has no test
// double of its own, so this stands in for it the same way other tests stand in for @agentfactory/db.
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "font-inter" }),
}));

const getCurrentUser = vi.fn();
vi.mock("@/server/auth", () => ({ getCurrentUser: () => getCurrentUser() }));

import RootLayout from "../layout";

function userWithTheme(theme?: ThemePreference): User {
  return { id: 1, email: "demo@acme.test", name: "Demo", preferences: theme ? { theme } : undefined };
}

describe("RootLayout", () => {
  it("stamps data-theme=light for a user with an explicit light preference", async () => {
    getCurrentUser.mockResolvedValue(userWithTheme("light"));
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBe("light");
  });

  it("stamps data-theme=dark for a user with an explicit dark preference", async () => {
    getCurrentUser.mockResolvedValue(userWithTheme("dark"));
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBe("dark");
  });

  it("omits data-theme for a user on system preference, deferring to CSS prefers-color-scheme", async () => {
    getCurrentUser.mockResolvedValue(userWithTheme("system"));
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBeUndefined();
  });

  it("omits data-theme when logged out, deferring to CSS prefers-color-scheme", async () => {
    getCurrentUser.mockResolvedValue(undefined);
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBeUndefined();
  });
});
