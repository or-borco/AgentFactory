import { describe, expect, it } from "vitest";
import "../setup.js";
import { getOrg, createOrg } from "../../repositories/orgs.js";
import { getUserByEmail, getUserById, createUser, updateUserThemePreference } from "../../repositories/users.js";
import { getPrimaryMembership, listOrgMembers } from "../../repositories/memberships.js";
import { hashPassword } from "../../password.js";
import { insertMembership, insertOrg, insertUser } from "../fixtures.js";

describe("orgs repository", () => {
  it("creates and fetches an org by id", async () => {
    const org = await createOrg("Acme", "acme");
    await expect(getOrg(org.id)).resolves.toEqual(org);
  });

  it("rejects a duplicate slug", async () => {
    await createOrg("Acme", "acme");
    await expect(createOrg("Acme Two", "acme")).rejects.toThrow();
  });

  it("returns undefined for a missing org", async () => {
    await expect(getOrg(999_999)).resolves.toBeUndefined();
  });
});

describe("users repository", () => {
  it("creates and fetches a user by id and email", async () => {
    const passwordHash = await hashPassword("password123");
    const user = await createUser({ email: "demo@example.com", name: "Demo", passwordHash });

    await expect(getUserById(user.id)).resolves.toEqual(user);
    await expect(getUserByEmail("demo@example.com")).resolves.toEqual({ ...user, passwordHash });
  });

  it("rejects a duplicate email", async () => {
    const passwordHash = await hashPassword("password123");
    await createUser({ email: "dup@example.com", name: "First", passwordHash });
    await expect(
      createUser({ email: "dup@example.com", name: "Second", passwordHash }),
    ).rejects.toThrow();
  });

  it("defaults a new user's theme preference to dark", async () => {
    const user = await insertUser();
    expect(user.themePreference).toBe("dark");
    await expect(getUserById(user.id)).resolves.toMatchObject({ themePreference: "dark" });
  });
});

describe("updateUserThemePreference", () => {
  it("persists the new preference and it survives a fresh read", async () => {
    const user = await insertUser();

    const updated = await updateUserThemePreference(user.id, "light");

    expect(updated?.themePreference).toBe("light");
    await expect(getUserById(user.id)).resolves.toMatchObject({ themePreference: "light" });
  });

  it("only changes the targeted user's preference — it's per-user, not global", async () => {
    const alice = await insertUser({ name: "Alice" });
    const bob = await insertUser({ name: "Bob" });

    await updateUserThemePreference(alice.id, "light");

    await expect(getUserById(alice.id)).resolves.toMatchObject({ themePreference: "light" });
    await expect(getUserById(bob.id)).resolves.toMatchObject({ themePreference: "dark" });
  });

  it("can switch back to dark", async () => {
    const user = await insertUser();
    await updateUserThemePreference(user.id, "light");

    const reverted = await updateUserThemePreference(user.id, "dark");

    expect(reverted?.themePreference).toBe("dark");
  });

  it("returns undefined for a non-existent user", async () => {
    await expect(updateUserThemePreference(999_999, "light")).resolves.toBeUndefined();
  });
});

describe("memberships repository", () => {
  it("returns the earliest membership as the primary one", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    const user = await insertUser();

    await insertMembership(org1.id, user.id, "member");
    await insertMembership(org2.id, user.id, "owner");

    await expect(getPrimaryMembership(user.id)).resolves.toEqual({
      orgId: org1.id,
      userId: user.id,
      role: "member",
    });
  });

  it("returns undefined when a user has no membership", async () => {
    const user = await insertUser();
    await expect(getPrimaryMembership(user.id)).resolves.toBeUndefined();
  });
});

describe("listOrgMembers", () => {
  it("returns members with user details joined", async () => {
    const org = await insertOrg();
    const user = await insertUser({ name: "Alice", email: "alice@example.com" });
    await insertMembership(org.id, user.id, "owner");

    const members = await listOrgMembers(org.id);

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      userId: user.id,
      orgId: org.id,
      role: "owner",
      name: "Alice",
      email: "alice@example.com",
    });
    expect(typeof members[0].joinedAt).toBe("string");
  });

  it("returns multiple members ordered by join date", async () => {
    const org = await insertOrg();
    const alice = await insertUser({ name: "Alice" });
    const bob = await insertUser({ name: "Bob" });
    await insertMembership(org.id, alice.id, "owner");
    await insertMembership(org.id, bob.id, "member");

    const members = await listOrgMembers(org.id);

    expect(members).toHaveLength(2);
    expect(members[0].name).toBe("Alice");
    expect(members[1].name).toBe("Bob");
  });

  it("returns empty list for an org with no members", async () => {
    const org = await insertOrg();
    await expect(listOrgMembers(org.id)).resolves.toEqual([]);
  });

  it("isolates members by org", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    const user1 = await insertUser({ name: "Org1 User" });
    const user2 = await insertUser({ name: "Org2 User" });
    await insertMembership(org1.id, user1.id, "member");
    await insertMembership(org2.id, user2.id, "member");

    const members = await listOrgMembers(org1.id);

    expect(members).toHaveLength(1);
    expect(members[0].name).toBe("Org1 User");
  });
});
