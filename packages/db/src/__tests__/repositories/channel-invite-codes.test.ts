import { describe, expect, it } from "vitest";
import "../setup.js";
import { insertOrg, insertUser, insertMembership } from "../fixtures.js";
import { createConnection } from "../../repositories/connections.js";
import {
  generateInviteCode,
  listInviteCodes,
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

  it("lists codes for a connection and revoke expires an outstanding one", async () => {
    const { org, user, connection } = await setup();
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    await revokeInviteCode(connection.id, invite.id);
    const [listed] = await listInviteCodes(connection.id);
    expect(new Date(listed.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());

    await expect(redeemInviteCode(invite.code, "chat-1")).resolves.toBeUndefined();
  });
});
