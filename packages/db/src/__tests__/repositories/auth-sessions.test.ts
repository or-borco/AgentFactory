import { describe, expect, it } from "vitest";
import "../setup.js";
import { createAuthSession, deleteAuthSession, getUserByTokenHash } from "../../repositories/auth-sessions.js";
import { insertUser } from "../fixtures.js";

describe("auth-sessions repository", () => {
  it("resolves a user from a valid, unexpired token hash", async () => {
    const user = await insertUser();
    await createAuthSession({
      tokenHash: "hash-valid",
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(getUserByTokenHash("hash-valid")).resolves.toEqual(user);
  });

  it("does not resolve an expired token", async () => {
    const user = await insertUser();
    await createAuthSession({
      tokenHash: "hash-expired",
      userId: user.id,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(getUserByTokenHash("hash-expired")).resolves.toBeUndefined();
  });

  it("does not resolve a deleted token", async () => {
    const user = await insertUser();
    await createAuthSession({
      tokenHash: "hash-deleted",
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await deleteAuthSession("hash-deleted");

    await expect(getUserByTokenHash("hash-deleted")).resolves.toBeUndefined();
  });

  it("returns undefined for an unknown token hash", async () => {
    await expect(getUserByTokenHash("does-not-exist")).resolves.toBeUndefined();
  });
});
