import { describe, expect, it, vi } from "vitest";
import type { User } from "@agentfactory/core";

// next/font/google relies on a Next.js build-time loader that isn't present under vitest;
// stub it with the same shape (an object exposing `.className`) so importing layout.tsx doesn't
// try to actually fetch/inline a font.
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-mock" }),
}));

const getCurrentUserMock = vi.fn<() => Promise<User | undefined>>();
vi.mock("@/server/auth", () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

const { default: RootLayout } = await import("../layout");

function user(preferences?: User["preferences"]): User {
  return { id: 1, email: "a@example.com", name: "A User", preferences };
}

describe("RootLayout", () => {
  it("stamps data-theme=dark for a user with an explicit dark preference", async () => {
    getCurrentUserMock.mockResolvedValue(user({ theme: "dark" }));
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBe("dark");
  });

  it("stamps data-theme=light for a user with an explicit light preference", async () => {
    getCurrentUserMock.mockResolvedValue(user({ theme: "light" }));
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBe("light");
  });

  it("omits data-theme for a 'system' preference, deferring to prefers-color-scheme", async () => {
    getCurrentUserMock.mockResolvedValue(user({ theme: "system" }));
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBeUndefined();
  });

  it("omits data-theme for a user with no preferences set", async () => {
    getCurrentUserMock.mockResolvedValue(user(undefined));
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBeUndefined();
  });

  it("omits data-theme when logged out (no user at all, e.g. (auth) routes)", async () => {
    getCurrentUserMock.mockResolvedValue(undefined);
    const element = await RootLayout({ children: null });
    expect(element.props["data-theme"]).toBeUndefined();
  });
});
