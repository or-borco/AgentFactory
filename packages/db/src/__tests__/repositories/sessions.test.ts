import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { agents } from "../../schema.js";
import {
  createSession,
  findSessionByExternalThread,
  getSession,
  listSessions,
  setSessionSandboxId,
  touchSessionActivity,
} from "../../repositories/sessions.js";
import { insertAgent, insertOrg, insertSession } from "../fixtures.js";

describe("sessions repository", () => {
  it("creates and fetches a session by id", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await createSession(org.id, agent.id, "New conversation");
    await expect(getSession(session.id)).resolves.toEqual(session);
  });

  it("gives each session its own random branchToken", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session1 = await createSession(org.id, agent.id, "Session 1");
    const session2 = await createSession(org.id, agent.id, "Session 2");

    expect(session1.branchToken).toBeTruthy();
    expect(session2.branchToken).toBeTruthy();
    expect(session1.branchToken).not.toBe(session2.branchToken);
  });

  it("lists sessions scoped to an org, optionally filtered by agent", async () => {
    const org = await insertOrg();
    const agent1 = await insertAgent(org.id, { name: "Agent 1" });
    const agent2 = await insertAgent(org.id, { name: "Agent 2" });
    const session1 = await insertSession(org.id, agent1.id, "Session 1");
    await insertSession(org.id, agent2.id, "Session 2");

    await expect(listSessions(org.id)).resolves.toHaveLength(2);
    const filtered = await listSessions(org.id, agent1.id);
    expect(filtered).toEqual([session1]);
  });

  it("updates lastActivityAt on touch", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);

    // Compare two touches (both client-generated timestamps) rather than the row's
    // creation-time default, which is set server-side and can race against the client clock.
    await touchSessionActivity(session.id);
    const first = await getSession(session.id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await touchSessionActivity(session.id);
    const second = await getSession(session.id);

    expect(new Date(second!.lastActivityAt).getTime()).toBeGreaterThan(
      new Date(first!.lastActivityAt).getTime(),
    );
  });

  it("sets the sandbox id", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);

    await setSessionSandboxId(session.id, "sandbox-123");

    await expect(getSession(session.id)).resolves.toMatchObject({ sandboxId: "sandbox-123" });
  });

  it("is deleted when its agent is deleted", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);

    await db.delete(agents).where(eq(agents.id, agent.id));

    await expect(getSession(session.id)).resolves.toBeUndefined();
  });

  it("creates a session with a non-web origin and externalThreadRef when opts are passed", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);

    const session = await createSession(org.id, agent.id, "Telegram — Test Agent", {
      origin: "telegram",
      externalThreadRef: "123456789",
    });

    expect(session.origin).toBe("telegram");
    expect(session.externalThreadRef).toBe("123456789");
  });

  it("finds a session by org, origin, and externalThreadRef", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const created = await createSession(org.id, agent.id, "Telegram — Test Agent", {
      origin: "telegram",
      externalThreadRef: "123456789",
    });

    await expect(findSessionByExternalThread(org.id, "telegram", "123456789")).resolves.toEqual(created);
  });

  it("returns undefined from findSessionByExternalThread when no session matches", async () => {
    const org = await insertOrg();
    await expect(findSessionByExternalThread(org.id, "telegram", "does-not-exist")).resolves.toBeUndefined();
  });

  // sessions_org_origin_external_thread_idx: without it, a double-tap on the Telegram agent menu
  // silently splits one chat across two sessions and two sandboxes.
  it("rejects a second session for the same (orgId, origin, externalThreadRef)", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    await createSession(org.id, agent.id, "Telegram — first", { origin: "telegram", externalThreadRef: "dup-ref" });

    await expect(
      createSession(org.id, agent.id, "Telegram — second", { origin: "telegram", externalThreadRef: "dup-ref" }),
      // Drizzle wraps the driver error, so SQLSTATE lives on `cause`, not on the thrown error.
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // The loser's insert is rolled back, so the original session is still the one lookups resolve
    // to — deterministically, not "whichever row Postgres returns first".
    const found = await findSessionByExternalThread(org.id, "telegram", "dup-ref");
    expect(found?.title).toBe("Telegram — first");
    expect(await listSessions(org.id)).toHaveLength(1);
  });

  it("scopes the uniqueness to org and origin, and leaves web sessions unconstrained", async () => {
    const orgA = await insertOrg();
    const orgB = await insertOrg();
    const agentA = await insertAgent(orgA.id);
    const agentB = await insertAgent(orgB.id);

    // Same thread ref is fine across orgs...
    const inA = await createSession(orgA.id, agentA.id, "A", { origin: "telegram", externalThreadRef: "shared-ref" });
    const inB = await createSession(orgB.id, agentB.id, "B", { origin: "telegram", externalThreadRef: "shared-ref" });
    expect(inA.id).not.toBe(inB.id);
    await expect(findSessionByExternalThread(orgA.id, "telegram", "shared-ref")).resolves.toMatchObject({ id: inA.id });
    await expect(findSessionByExternalThread(orgB.id, "telegram", "shared-ref")).resolves.toMatchObject({ id: inB.id });

    // ...and the partial index lets any number of web sessions share a NULL external_thread_ref.
    await createSession(orgA.id, agentA.id, "Web 1");
    await createSession(orgA.id, agentA.id, "Web 2");
    await expect(listSessions(orgA.id)).resolves.toHaveLength(3);
  });
});
