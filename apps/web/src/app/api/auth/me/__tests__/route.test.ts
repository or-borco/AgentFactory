import { beforeEach, describe, expect, it, vi } from "vitest";

const updateUserPreferencesMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  updateUserPreferences: (...args: unknown[]) => updateUserPreferencesMock(...args),
}));
const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));

import { GET, PATCH } from "../route";

const USER = { id: 5, email: "demo@example.com", name: "Demo", preferences: {} };

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/auth/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  updateUserPreferencesMock.mockReset();
  requireAuthContextMock.mockReset();
  requireAuthContextMock.mockResolvedValue({ user: USER, orgId: 1 });
});

describe("GET /api/auth/me", () => {
  it("answers 401 when unauthenticated", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
  });

  it("returns the current user with orgId", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ...USER, orgId: 1 });
  });
});

describe("PATCH /api/auth/me", () => {
  it("answers 401 without touching the DB when unauthenticated", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await PATCH(patchRequest({ theme: "dark" }));

    expect(res.status).toBe(401);
    expect(updateUserPreferencesMock).not.toHaveBeenCalled();
  });

  it("answers 400 for an invalid theme value without touching the DB", async () => {
    const res = await PATCH(patchRequest({ theme: "blue" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid theme" });
    expect(updateUserPreferencesMock).not.toHaveBeenCalled();
  });

  it("answers 400 when theme is missing", async () => {
    const res = await PATCH(patchRequest({}));

    expect(res.status).toBe(400);
    expect(updateUserPreferencesMock).not.toHaveBeenCalled();
  });

  it.each(["light", "dark", "system"] as const)(
    "persists a %s theme and returns the updated user with orgId",
    async (theme) => {
      const updated = { ...USER, preferences: { theme } };
      updateUserPreferencesMock.mockResolvedValue(updated);

      const res = await PATCH(patchRequest({ theme }));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ...updated, orgId: 1 });
      expect(updateUserPreferencesMock).toHaveBeenCalledWith(USER.id, { theme });
    },
  );
});
