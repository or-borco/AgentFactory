import { describe, expect, it } from "vitest";
import "../setup.js";
import { getOrg, createOrg } from "../../repositories/orgs.js";
import { getUserByEmail, getUserById, createUser } from "../../repositories/users.js";
import { getPrimaryMembership, listOrgMembers, createMembership, getOrgOwnerUserId } from "../../repositories/memberships.js";
import { hashPassword } from "../../password.js";
import { insertOrg, insertUser } from "../fixtures.js";

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

    await createMembership({ orgId: org1.id, userId: user.id, role: "member" });
    await createMembership({ orgId: org2.id, userId: user.id, role: "owner" });

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
    await createMembership({ orgId: org.id, userId: user.id, role: "owner" });

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
    await createMembership({ orgId: org.id, userId: alice.id, role: "owner" });
    await createMembership({ orgId: org.id, userId: bob.id, role: "member" });

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
    await createMembership({ orgId: org1.id, userId: user1.id, role: "member" });
    await createMembership({ orgId: org2.id, userId: user2.id, role: "member" });

    const members = await listOrgMembers(org1.id);

    expect(members).toHaveLength(1);
    expect(members[0].name).toBe("Org1 User");
  });
});

describe("getOrgOwnerUserId", () => {
  it("returns undefined for an org with no owner membership", async () => {
    const org = await insertOrg();
    await expect(getOrgOwnerUserId(org.id)).resolves.toBeUndefined();
  });

  it("returns the owner's user id", async () => {
    const org = await insertOrg();
    const member = await insertUser();
    const owner = await insertUser();
    await createMembership({ orgId: org.id, userId: member.id, role: "member" });
    await createMembership({ orgId: org.id, userId: owner.id, role: "owner" });

    await expect(getOrgOwnerUserId(org.id)).resolves.toBe(owner.id);
  });

  it("returns the earliest owner when an org somehow has more than one", async () => {
    const org = await insertOrg();
    const firstOwner = await insertUser();
    const secondOwner = await insertUser();
    await createMembership({ orgId: org.id, userId: firstOwner.id, role: "owner" });
    // memberships has no id column — its PK is (userId, orgId) — so ordering by createdAt alone
    // is only deterministic if the two inserts land in different timestamps. A tiny delay avoids
    // a flaky tie on a fast test run.
    await new Promise((r) => setTimeout(r, 5));
    await createMembership({ orgId: org.id, userId: secondOwner.id, role: "owner" });

    await expect(getOrgOwnerUserId(org.id)).resolves.toBe(firstOwner.id);
  });
});
