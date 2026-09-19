import { describe, expect, it } from "vitest";
import "../setup.js";
import { insertOrg, insertUser, insertMembership } from "../fixtures.js";
import { createConnection } from "../../repositories/connections.js";
import {
  generateInviteCode,
  getInviteCodeRedeemer,
  listInviteCodes,
  looksLikeInviteCode,
  redeemInviteCode,
  revokeInviteCode,
} from "../../repositories/channel-invite-codes.js";

async function setup() {
  const org = await insertOrg();
  const user = await insertUser();
  await insertMembership(org.id, user.id, "admin");
  const connection = await createConnection(org.id, {
    provider: "telegram",
    kind: "channel",
    label: "Telegram",
    config: { botUsername: "test_bot", webhookSecret: "wh-secret" },
  });
  return { org, user, connection };
}

describe("channel-invite-codes repository", () => {
  it("generates a code that redeems exactly once", async () => {
    const { org, user, connection } = await setup();
    const invite = await generateInviteCode(org.id, connection.id, user.id);
    expect(invite.code).toHaveLength(8);
    expect(invite.redeemedAt).toBeUndefined();

    const redeemed = await redeemInviteCode(invite.code, "chat-1");
    expect(redeemed?.redeemedByExternalUserId).toBe("chat-1");

    const secondAttempt = await redeemInviteCode(invite.code, "chat-2");
    expect(secondAttempt).toBeUndefined();
  });

  it("does not redeem an expired code", async () => {
    const { org, user, connection } = await setup();
    const invite = await generateInviteCode(org.id, connection.id, user.id, -1); // already expired
    await expect(redeemInviteCode(invite.code, "chat-1")).resolves.toBeUndefined();
  });

  it("does not redeem an unknown code", async () => {
    await expect(redeemInviteCode("nonexist", "chat-1")).resolves.toBeUndefined();
  });

  it("only one of two concurrent redemption attempts succeeds", async () => {
    const { org, user, connection } = await setup();
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    const [first, second] = await Promise.all([
      redeemInviteCode(invite.code, "chat-a"),
      redeemInviteCode(invite.code, "chat-b"),
    ]);
    const successes = [first, second].filter((r) => r !== undefined);
    expect(successes).toHaveLength(1);
  });

  describe("looksLikeInviteCode", () => {
    it("accepts a freshly minted code, in either case", async () => {
      const { org, user, connection } = await setup();
      const invite = await generateInviteCode(org.id, connection.id, user.id);

      expect(looksLikeInviteCode(invite.code)).toBe(true);
      expect(looksLikeInviteCode(invite.code.toLowerCase())).toBe(true);
    });

    it("rejects ordinary chatter and near-misses", () => {
      for (const candidate of [
        "hi",
        "hello there",
        "what is this?",
        "ABCDEFG", // one char short
        "ABCDEFGHI", // one char long
        "ABCDEF0H", // 0 and 1 are deliberately not in the alphabet
        "ABCDEF1H",
        "ABCDEF-H",
        "",
      ]) {
        expect(looksLikeInviteCode(candidate)).toBe(false);
      }
    });
  });

  it("lists codes for a connection and revoke expires an outstanding one", async () => {
    const { org, user, connection } = await setup();
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    await revokeInviteCode(connection.id, invite.id);
    const [listed] = await listInviteCodes(connection.id);
    expect(new Date(listed.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());

    await expect(redeemInviteCode(invite.code, "chat-1")).resolves.toBeUndefined();
  });
});

describe("getInviteCodeRedeemer", () => {
  it("returns undefined when this chat has never redeemed a code on this connection", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, {
      provider: "telegram",
      kind: "channel",
      label: "Telegram",
      auth: "api_token",
      config: {},
    });
    await expect(getInviteCodeRedeemer(connection.id, "42")).resolves.toBeUndefined();
  });

  it("returns the createdBy of the code this chat redeemed", async () => {
    const org = await insertOrg();
    const admin = await insertUser();
    const connection = await createConnection(org.id, {
      provider: "telegram",
      kind: "channel",
      label: "Telegram",
      auth: "api_token",
      config: {},
    });
    const invite = await generateInviteCode(org.id, connection.id, admin.id);
    await redeemInviteCode(invite.code, "42");

    const redeemer = await getInviteCodeRedeemer(connection.id, "42");

    expect(redeemer?.createdBy).toBe(admin.id);
  });

  it("picks the most recently redeemed code when a chat has redeemed more than one", async () => {
    const org = await insertOrg();
    const admin1 = await insertUser();
    const admin2 = await insertUser();
    const connection = await createConnection(org.id, {
      provider: "telegram",
      kind: "channel",
      label: "Telegram",
      auth: "api_token",
      config: {},
    });
    const invite1 = await generateInviteCode(org.id, connection.id, admin1.id);
    await redeemInviteCode(invite1.code, "42");
    const invite2 = await generateInviteCode(org.id, connection.id, admin2.id);
    await redeemInviteCode(invite2.code, "42");

    const redeemer = await getInviteCodeRedeemer(connection.id, "42");

    expect(redeemer?.createdBy).toBe(admin2.id);
  });
});
