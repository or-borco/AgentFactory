import { describe, expect, it } from "vitest";
import "../setup.js";
import { insertOrg } from "../fixtures.js";
import { createConnection } from "../../repositories/connections.js";
import {
  authorizeExternalUser,
  getAuthorizationStatus,
  listAuthorizedUsers,
  revokeAuthorizedUser,
} from "../../repositories/channel-authorized-users.js";

async function setupConnection() {
  const org = await insertOrg();
  return createConnection(org.id, {
    provider: "telegram",
    kind: "channel",
    label: "Telegram",
    config: { botUsername: "test_bot", webhookSecret: "wh-secret" },
  });
}

describe("channel-authorized-users repository", () => {
  it("reports unknown for a chat that has never redeemed a code", async () => {
    const connection = await setupConnection();
    await expect(getAuthorizationStatus(connection.id, "chat-1")).resolves.toBe("unknown");
  });

  it("authorizes a chat and reports it as authorized", async () => {
    const connection = await setupConnection();
    await authorizeExternalUser(connection.id, "chat-1");
    await expect(getAuthorizationStatus(connection.id, "chat-1")).resolves.toBe("authorized");
  });

  it("revoking flips status to revoked, not back to unknown", async () => {
    const connection = await setupConnection();
    const authorized = await authorizeExternalUser(connection.id, "chat-1");
    await revokeAuthorizedUser(connection.id, authorized.id);
    await expect(getAuthorizationStatus(connection.id, "chat-1")).resolves.toBe("revoked");
  });

  it("re-authorizing a revoked chat clears revokedAt", async () => {
    const connection = await setupConnection();
    const authorized = await authorizeExternalUser(connection.id, "chat-1");
    await revokeAuthorizedUser(connection.id, authorized.id);

    await authorizeExternalUser(connection.id, "chat-1");
    await expect(getAuthorizationStatus(connection.id, "chat-1")).resolves.toBe("authorized");
  });

  it("lists authorized users for a connection", async () => {
    const connection = await setupConnection();
    await authorizeExternalUser(connection.id, "chat-1");
    await authorizeExternalUser(connection.id, "chat-2");
    const listed = await listAuthorizedUsers(connection.id);
    expect(listed.map((u) => u.externalUserId).sort()).toEqual(["chat-1", "chat-2"]);
  });
});
