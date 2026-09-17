import { describe, expect, it } from "vitest";
import "../setup.js";
import { insertOrg, insertUser, insertTask } from "../fixtures.js";
import { createConnection } from "../../repositories/connections.js";
import {
  authorizeExternalUser,
  getAuthorizationStatus,
  getAuthorizedUser,
  listAuthorizedUsers,
  revokeAuthorizedUser,
  setActiveTask,
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

async function setupConnectionAndOrg() {
  const org = await insertOrg();
  const connection = await createConnection(org.id, {
    provider: "telegram",
    kind: "channel",
    label: "Telegram",
    auth: "api_token",
    config: {},
  });
  return { org, connection };
}

describe("getAuthorizedUser", () => {
  it("returns undefined for a chat that never authorized", async () => {
    const { connection } = await setupConnectionAndOrg();
    await expect(getAuthorizedUser(connection.id, "999")).resolves.toBeUndefined();
  });

  it("returns the row, with activeTaskId unset, right after authorization", async () => {
    const { connection } = await setupConnectionAndOrg();
    await authorizeExternalUser(connection.id, "42");

    const row = await getAuthorizedUser(connection.id, "42");

    expect(row?.externalUserId).toBe("42");
    expect(row?.activeTaskId).toBeUndefined();
  });
});

describe("setActiveTask", () => {
  it("sets and clears the chat's active task pointer", async () => {
    const { org, connection } = await setupConnectionAndOrg();
    const user = await insertUser();
    const task = await insertTask(org.id, user.id);
    await authorizeExternalUser(connection.id, "42");

    await setActiveTask(connection.id, "42", task.id);
    expect((await getAuthorizedUser(connection.id, "42"))?.activeTaskId).toBe(task.id);

    await setActiveTask(connection.id, "42", null);
    expect((await getAuthorizedUser(connection.id, "42"))?.activeTaskId).toBeUndefined();
  });

  it("survives a revoke/re-authorize cycle untouched", async () => {
    const { org, connection } = await setupConnectionAndOrg();
    const user = await insertUser();
    const task = await insertTask(org.id, user.id);
    const authorized = await authorizeExternalUser(connection.id, "42");
    await setActiveTask(connection.id, "42", task.id);

    // revokeAuthorizedUser only ever sets revokedAt (see its own implementation) — re-authorizing
    // afterwards must not have wiped activeTaskId, since authorizeExternalUser's upsert only
    // touches revokedAt too. revokeAuthorizedUser is already imported at the top of this file.
    await revokeAuthorizedUser(connection.id, authorized.id);
    await authorizeExternalUser(connection.id, "42");

    expect((await getAuthorizedUser(connection.id, "42"))?.activeTaskId).toBe(task.id);
  });
});
