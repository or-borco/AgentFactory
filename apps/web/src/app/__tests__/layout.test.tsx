import { describe, expect, it, vi } from "vitest";
import type { User } from "@agentfactory/core";

vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-mock" }),
}));

const getCurrentUserMock = vi.fn();
vi.mock("@/server/auth", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUserMock(...args),
}));

vi.mock("@/lib/i18n/context", () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import RootLayout from "../layout";

// RootLayout is an async Server Component — we call it directly (as Next.js does) and inspect
// the returned element tree rather than rendering into a DOM, since the `data-theme` stamp is a
// prop on the `<html>` element, not something that needs a browser to observe.
async function renderRootLayout(user: User | undefined) {
  getCurrentUserMock.mockResolvedValue(user);
  const element = await RootLayout({ children: "child" });
  return element;
}

describe("RootLayout theme stamp", () => {
  it("stamps data-theme=\"light\" for a user with an explicit light preference", async () => {
    const html = await renderRootLayout({
      id: 1,
      email: "a@example.com",
      name: "A",
      preferences: { theme: "light" },
    });

    expect(html.props["data-theme"]).toBe("light");
  });

  it("stamps data-theme=\"dark\" for a user with an explicit dark preference", async () => {
    const html = await renderRootLayout({
      id: 1,
      email: "a@example.com",
      name: "A",
      preferences: { theme: "dark" },
    });

    expect(html.props["data-theme"]).toBe("dark");
  });

  it("omits data-theme for a user with theme \"system\", deferring to prefers-color-scheme", async () => {
    const html = await renderRootLayout({
      id: 1,
      email: "a@example.com",
      name: "A",
      preferences: { theme: "system" },
    });

    expect(html.props["data-theme"]).toBeUndefined();
  });

  it("omits data-theme for a user with no stored preference", async () => {
    const html = await renderRootLayout({ id: 1, email: "a@example.com", name: "A" });

    expect(html.props["data-theme"]).toBeUndefined();
  });

  it("omits data-theme when logged out (e.g. the (auth) routes)", async () => {
    const html = await renderRootLayout(undefined);

    expect(html.props["data-theme"]).toBeUndefined();
  });
});
