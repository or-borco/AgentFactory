import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { sessions } from "../../schema.js";
import { createRun, hasNonTerminalRun, updateRunStatus } from "../../repositories/runs.js";
import { listIdleSandboxSessions, setSessionSandbox } from "../../repositories/sessions.js";
import { insertAgent, insertOrg, insertSession } from "../fixtures.js";
import type { Session } from "@agentfactory/core";

const HOUR = 60 * 60 * 1000;

async function setupIdleSandboxSession(): Promise<Session> {
  const org = await insertOrg();
  const agent = await insertAgent(org.id);
  const session = await insertSession(org.id, agent.id);
  await setSessionSandbox(session.id, "sandbox-123", "arata-sandbox-node:local");
  await backdateLastActivity(session.id, 3 * HOUR);
  return session;
}

// listIdleSandboxSessions/hasNonTerminalRun have no setter for an arbitrary lastActivityAt (the
// only writer, touchSessionActivity, always stamps "now") — tests reach past the repository to
// set it directly, the same way sessions.test.ts reaches for `db` to assert FK cascade behavior.
async function backdateLastActivity(sessionId: number, ageMs: number): Promise<void> {
  await db
    .update(sessions)
    .set({ lastActivityAt: new Date(Date.now() - ageMs) })
    .where(eq(sessions.id, sessionId));
}

describe("listIdleSandboxSessions", () => {
  it("excludes a session with no sandbox", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);
    await backdateLastActivity(session.id, 3 * HOUR);

    const idle = await listIdleSandboxSessions(new Date(Date.now() - 2 * HOUR));

    expect(idle.map((s) => s.id)).not.toContain(session.id);
  });

  it("includes an idle session with a sandbox and no runs", async () => {
    const session = await setupIdleSandboxSession();

    const idle = await listIdleSandboxSessions(new Date(Date.now() - 2 * HOUR));

    expect(idle.map((s) => s.id)).toContain(session.id);
  });

  it("includes an idle session whose only runs are terminal", async () => {
    const session = await setupIdleSandboxSession();
    const done = await createRun(session.id);
    await updateRunStatus(done.id, "done");
    const failed = await createRun(session.id);
    await updateRunStatus(failed.id, "failed");
    const cancelled = await createRun(session.id);
    await updateRunStatus(cancelled.id, "cancelled");

    const idle = await listIdleSandboxSessions(new Date(Date.now() - 2 * HOUR));

    expect(idle.map((s) => s.id)).toContain(session.id);
  });

  it("excludes an idle session with a non-terminal run", async () => {
    const session = await setupIdleSandboxSession();
    await createRun(session.id); // defaults to "queued"

    const idle = await listIdleSandboxSessions(new Date(Date.now() - 2 * HOUR));

    expect(idle.map((s) => s.id)).not.toContain(session.id);
    await expect(hasNonTerminalRun(session.id)).resolves.toBe(true);
  });

  it("excludes a session with a sandbox that is not yet idle", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);
    await setSessionSandbox(session.id, "sandbox-123", "arata-sandbox-node:local");
    await backdateLastActivity(session.id, 5 * 60 * 1000); // 5 minutes ago

    const idle = await listIdleSandboxSessions(new Date(Date.now() - 2 * HOUR));

    expect(idle.map((s) => s.id)).not.toContain(session.id);
  });
});

describe("hasNonTerminalRun", () => {
  it("returns false when the session has no runs", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);

    await expect(hasNonTerminalRun(session.id)).resolves.toBe(false);
  });

  it("returns false when every run is terminal", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);
    const run = await createRun(session.id);
    await updateRunStatus(run.id, "done");

    await expect(hasNonTerminalRun(session.id)).resolves.toBe(false);
  });

  it("returns true when a run is in a non-terminal status", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);
    const run = await createRun(session.id);
    await updateRunStatus(run.id, "running");

    await expect(hasNonTerminalRun(session.id)).resolves.toBe(true);
  });
});
