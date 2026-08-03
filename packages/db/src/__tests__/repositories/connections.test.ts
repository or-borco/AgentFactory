import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { orgs } from "../../schema.js";
import { createConnection, deleteConnection, getConnection, listConnections } from "../../repositories/connections.js";
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

    await expect(getConnection(connection.id)).resolves.toEqual(connection);
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

  it("stores arbitrary provider-specific config as opaque json", async () => {
    const org = await insertOrg();
    const config = { installationId: 999, accountLogin: "some-org", accountType: "Organization" };
    const connection = await createConnection(org.id, { provider: "github", kind: "scm", label: "some-org", config });

    expect(connection.config).toEqual(config);
  });

  it("deletes a connection", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, { provider: "github", kind: "scm", label: "acme-org/platform", config: {} });

    await deleteConnection(connection.id);

    await expect(getConnection(connection.id)).resolves.toBeUndefined();
  });

  it("is deleted when its org is deleted", async () => {
    const org = await insertOrg();
    const connection = await createConnection(org.id, { provider: "github", kind: "scm", label: "acme-org/platform", config: {} });

    await db.delete(orgs).where(eq(orgs.id, org.id));

    await expect(getConnection(connection.id)).resolves.toBeUndefined();
  });
});
