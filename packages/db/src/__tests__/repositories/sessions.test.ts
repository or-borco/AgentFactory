import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { agents } from "../../schema.js";
import {
  clearSessionSandbox,
  createSession,
  getSession,
  listSessions,
  setSessionSandbox,
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

  it("setSessionSandbox stores both sandboxId and sandboxImage", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);

    await setSessionSandbox(session.id, "container-1", "arata-sandbox-python:local");

    await expect(getSession(session.id)).resolves.toMatchObject({
      sandboxId: "container-1",
      sandboxImage: "arata-sandbox-python:local",
    });
  });

  it("clearSessionSandbox nulls both sandboxId and sandboxImage", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);
    await setSessionSandbox(session.id, "container-1", "arata-sandbox-python:local");

    await clearSessionSandbox(session.id);

    const found = await getSession(session.id);
    expect(found?.sandboxId).toBeUndefined();
    expect(found?.sandboxImage).toBeUndefined();
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

});
