import { describe, expect, it } from "vitest";
import "../setup.js";
import { insertOrg } from "../fixtures.js";
import { createConnection } from "../../repositories/connections.js";
import {
  clearRedemptionAttempts,
  isInCooldown,
  recordFailedRedemption,
} from "../../repositories/channel-redemption-attempts.js";

async function setupConnection() {
  const org = await insertOrg();
  return createConnection(org.id, {
    provider: "telegram",
    kind: "channel",
    label: "Telegram",
    config: { botUsername: "test_bot", webhookSecret: "wh-secret" },
  });
}

describe("channel-redemption-attempts repository", () => {
  it("is not in cooldown with no prior attempts", async () => {
    const connection = await setupConnection();
    await expect(isInCooldown(connection.id, "chat-1")).resolves.toBe(false);
  });

  it("enters cooldown after 5 failed attempts", async () => {
    const connection = await setupConnection();
    for (let i = 0; i < 4; i++) {
      await recordFailedRedemption(connection.id, "chat-1");
      expect(await isInCooldown(connection.id, "chat-1")).toBe(false);
    }
    await recordFailedRedemption(connection.id, "chat-1");
    await expect(isInCooldown(connection.id, "chat-1")).resolves.toBe(true);
  });

  it("clearing attempts (on a successful redemption) exits cooldown", async () => {
    const connection = await setupConnection();
    for (let i = 0; i < 5; i++) await recordFailedRedemption(connection.id, "chat-1");
    await expect(isInCooldown(connection.id, "chat-1")).resolves.toBe(true);

    await clearRedemptionAttempts(connection.id, "chat-1");
    await expect(isInCooldown(connection.id, "chat-1")).resolves.toBe(false);
  });

  it("tracks attempts independently per external user", async () => {
    const connection = await setupConnection();
    for (let i = 0; i < 5; i++) await recordFailedRedemption(connection.id, "chat-1");
    await expect(isInCooldown(connection.id, "chat-2")).resolves.toBe(false);
  });
});
