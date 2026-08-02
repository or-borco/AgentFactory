import { describe, expect, it } from "vitest";
import "../setup.js";
import { getOrg, createOrg } from "../../repositories/orgs.js";
import { getUserByEmail, getUserById, createUser } from "../../repositories/users.js";
import { getPrimaryMembership } from "../../repositories/memberships.js";
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
