import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieStoreMock = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve(cookieStoreMock),
}));

const getUserByTokenHashMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  createAuthSession: vi.fn(),
  deleteAuthSession: vi.fn(),
  getPrimaryMembership: vi.fn(),
  getUserByTokenHash: (...args: unknown[]) => getUserByTokenHashMock(...args),
}));

import { getCurrentUser } from "../auth";

// getCurrentUser is wrapped in React's cache() (per the theme-preference design spec) so the
// root layout's theme read and (app)/layout.tsx's auth guard share one DB call per request.
// cache()'s actual dedup only kicks in inside a real React Server Component render pass (there's
// no lightweight way to fake that dispatcher in a unit test), so this just guards the
// behavior-preserving part of that refactor: same inputs still produce the same outputs.
describe("getCurrentUser", () => {
  beforeEach(() => {
    cookieStoreMock.get.mockReset();
    getUserByTokenHashMock.mockReset();
  });

  it("returns undefined when there's no session cookie", async () => {
    cookieStoreMock.get.mockReturnValue(undefined);

    await expect(getCurrentUser()).resolves.toBeUndefined();
    expect(getUserByTokenHashMock).not.toHaveBeenCalled();
  });

  it("resolves the user for the hashed session token when the cookie is present", async () => {
    const user = { id: 7, email: "demo@example.com", name: "Demo" };
    cookieStoreMock.get.mockReturnValue({ value: "raw-token" });
    getUserByTokenHashMock.mockResolvedValue(user);

    await expect(getCurrentUser()).resolves.toEqual(user);
    // The raw cookie value is never handed to the DB layer directly — only its SHA-256 hash is,
    // mirroring how the token was persisted at session-creation time.
    expect(getUserByTokenHashMock).toHaveBeenCalledTimes(1);
    expect(getUserByTokenHashMock).toHaveBeenCalledWith(expect.any(String));
    expect(getUserByTokenHashMock.mock.calls[0][0]).not.toBe("raw-token");
  });
});
