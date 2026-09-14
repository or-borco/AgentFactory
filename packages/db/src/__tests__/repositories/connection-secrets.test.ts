import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { connections, orgs } from "../../schema.js";
import { createConnection } from "../../repositories/connections.js";
import {
  createConnectionSecret,
  deleteConnectionSecret,
  readConnectionSecret,
} from "../../repositories/connection-secrets.js";
import { insertOrg } from "../fixtures.js";

describe("connection-secrets repository", () => {
  it("round-trips a secret through the real database", async () => {
    const org = await insertOrg();
    const plaintext = { apiToken: "secret-token-value", accountEmail: "bot@acme.com" };

    const id = await createConnectionSecret(org.id, plaintext);

    await expect(readConnectionSecret(org.id, id)).resolves.toEqual(plaintext);
  });

  it("does not let a different org read the secret by id", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    const id = await createConnectionSecret(org1.id, { apiToken: "secret-token-value" });

    await expect(readConnectionSecret(org2.id, id)).resolves.toBeUndefined();
  });

  it("is deleted when its org is deleted", async () => {
    const org = await insertOrg();
    const id = await createConnectionSecret(org.id, { apiToken: "secret-token-value" });

    await db.delete(orgs).where(eq(orgs.id, org.id));

    await expect(readConnectionSecret(org.id, id)).resolves.toBeUndefined();
  });

  it("nulls out a referencing connection's credentialRef on delete, without deleting the connection", async () => {
    const org = await insertOrg();
    const secretId = await createConnectionSecret(org.id, { apiToken: "secret-token-value" });
    const connection = await createConnection(org.id, {
      provider: "jira",
      kind: "tasks",
      label: "Acme Jira",
      config: { siteUrl: "https://acme.atlassian.net" },
      auth: "api_token",
      credentialRef: secretId,
    });

    await deleteConnectionSecret(org.id, secretId);

    const [row] = await db.select().from(connections).where(eq(connections.id, connection.id));
    expect(row).toBeDefined();
    expect(row.credentialRef).toBeNull();
  });
});
