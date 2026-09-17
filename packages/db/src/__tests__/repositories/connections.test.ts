import { eq } from "drizzle-orm";
import type { ConnectionHealth } from "@agentfactory/core";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { orgs } from "../../schema.js";
import {
  createConnection,
  deleteConnection,
  findChannelConnectionByWebhookSecret,
  getConnection,
  listConnections,
  setConnectionHealth,
  updateConnection,
} from "../../repositories/connections.js";
import { insertOrg } from "../fixtures.js";

describe("connections repository", () => {
  it("creates and fetches a connection by id", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, {
      provider: "github",
      kind: "scm",
      label: "acme-org/platform",
      config: { installationId: 123, accountLogin: "acme-org", accountType: "Organization" },
    });

    await expect(getConnection(org.id, connection.id)).resolves.toEqual(connection);
  });

  it("defaults health to healthy on create", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, {
      provider: "github",
      kind: "scm",
      label: "acme-org/platform",
      config: {},
    });

    expect(connection.health).toBe("healthy");
  });

  it("lists only connections belonging to the given org", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    const conn1 = await createConnection(org1.id, { provider: "github", kind: "scm", label: "org1/repo", config: {} });
    await createConnection(org2.id, { provider: "github", kind: "scm", label: "org2/repo", config: {} });

    const connections = await listConnections(org1.id);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toEqual(conn1);
  });

  it("does not return a connection when queried under a different org", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    const connection = await createConnection(org1.id, { provider: "github", kind: "scm", label: "org1/repo", config: {} });

    await expect(getConnection(org2.id, connection.id)).resolves.toBeUndefined();
  });

  it("stores arbitrary provider-specific config as opaque json", async () => {
    const org = await insertOrg();
    const config = { installationId: 999, accountLogin: "some-org", accountType: "Organization" };
    const connection = await createConnection(org.id, { provider: "github", kind: "scm", label: "some-org", config });

    expect(connection.config).toEqual(config);
  });

  it("strips webhookSecret out of the returned config, on both create and read", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, {
      provider: "telegram",
      kind: "channel",
      label: "@test_bot",
      config: { botUsername: "test_bot", webhookSecret: "should-not-leak" },
    });

    expect(connection.config).not.toHaveProperty("webhookSecret");
    expect(connection.config).toMatchObject({ botUsername: "test_bot" });

    const fetched = await getConnection(org.id, connection.id);
    expect(fetched?.config).not.toHaveProperty("webhookSecret");
    expect(fetched?.config).toMatchObject({ botUsername: "test_bot" });
  });

  it("deletes a connection", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, { provider: "github", kind: "scm", label: "acme-org/platform", config: {} });

    await deleteConnection(connection.id);

    await expect(getConnection(org.id, connection.id)).resolves.toBeUndefined();
  });

  it("is deleted when its org is deleted", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, { provider: "github", kind: "scm", label: "acme-org/platform", config: {} });

    await db.delete(orgs).where(eq(orgs.id, org.id));

    await expect(getConnection(org.id, connection.id)).resolves.toBeUndefined();
  });

  it("defaults auth to none on create", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, {
      provider: "github",
      kind: "scm",
      label: "acme-org/platform",
      config: {},
    });

    expect(connection.auth).toBe("none");
  });

  describe("updateConnection", () => {
    it("updates label, config, and health", async () => {
      const org = await insertOrg();
      const connection = await createConnection(org.id, {
        provider: "jira",
        kind: "tasks",
        label: "Acme Jira",
        config: { siteUrl: "https://acme.atlassian.net" },
      });

      const updated = await updateConnection(org.id, connection.id, {
        label: "Acme Jira (renamed)",
        config: { siteUrl: "https://acme.atlassian.net", accountEmail: "bot@acme.com" },
        health: "needs-attention",
      });

      expect(updated).toMatchObject({
        label: "Acme Jira (renamed)",
        config: { siteUrl: "https://acme.atlassian.net", accountEmail: "bot@acme.com" },
        health: "needs-attention",
      });
    });

    it("is org-scoped: an update with the wrong orgId returns undefined and mutates nothing", async () => {
      const org1 = await insertOrg();
      const org2 = await insertOrg();
      const connection = await createConnection(org1.id, {
        provider: "jira",
        kind: "tasks",
        label: "Acme Jira",
        config: {},
      });

      const result = await updateConnection(org2.id, connection.id, { label: "Hijacked" });

      expect(result).toBeUndefined();
      await expect(getConnection(org1.id, connection.id)).resolves.toMatchObject({ label: "Acme Jira" });
    });
  });

  it("finds a channel connection by its webhookSecret across orgs", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, {
      provider: "telegram",
      kind: "channel",
      label: "Telegram",
      config: { botUsername: "test_bot", webhookSecret: "unique-secret-abc" },
    });

    const found = await findChannelConnectionByWebhookSecret("unique-secret-abc");
    expect(found?.connection).toEqual(connection);
    expect(found?.orgId).toBe(org.id);
  });

  it("returns undefined for an unknown webhookSecret", async () => {
    await expect(findChannelConnectionByWebhookSecret("no-such-secret")).resolves.toBeUndefined();
  });

  describe("setConnectionHealth", () => {
    it.each<ConnectionHealth>(["healthy", "needs-attention", "expired"])(
      "round-trips health value %s",
      async (health) => {
        const org = await insertOrg();
        const connection = await createConnection(org.id, {
          provider: "jira",
          kind: "tasks",
          label: "Acme Jira",
          config: {},
        });

        await setConnectionHealth(org.id, connection.id, health);

        await expect(getConnection(org.id, connection.id)).resolves.toMatchObject({ health });
      },
    );
  });
});
