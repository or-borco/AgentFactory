import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { events } from "../../schema.js";
import { createEvent } from "../../repositories/events.js";
import { createMessage, getMessage, listMessages } from "../../repositories/messages.js";
import { createRun, getLatestProviderSessionRef, getRun, updateRunStatus } from "../../repositories/runs.js";
import { insertAgent, insertOrg, insertSession } from "../fixtures.js";
import type { Session } from "@agentfactory/core";

async function setupSession(): Promise<Session> {
  const org = await insertOrg();
  const agent = await insertAgent(org.id);
  return insertSession(org.id, agent.id);
}

describe("messages repository", () => {
  it("creates a user message and lists it back", async () => {
    const session = await setupSession();
    const message = await createMessage(session.id, "user", "Please review PR 1234");

    await expect(getMessage(message.id)).resolves.toEqual(message);
    await expect(listMessages(session.id)).resolves.toEqual([message]);
  });

  it("links an assistant message to the run that produced it", async () => {
    const session = await setupSession();
    const userMessage = await createMessage(session.id, "user", "Please review PR 1234");
    const run = await createRun(session.id, userMessage.id);
    const assistantMessage = await createMessage(session.id, "assistant", "Looks good", run.id);

    expect(assistantMessage.runId).toBe(run.id);
    await expect(listMessages(session.id)).resolves.toHaveLength(2);
  });
});

describe("runs repository", () => {
  it("creates a queued run and updates its status", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    expect(run.status).toBe("queued");

    const updated = await updateRunStatus(run.id, "done", {
      finishedAt: new Date(),
      providerSessionRef: "provider-ref-1",
    });

    expect(updated).toMatchObject({ status: "done", providerSessionRef: "provider-ref-1" });
    await expect(getRun(run.id)).resolves.toMatchObject({ status: "done" });
  });

  it("finds the latest completed run's provider session ref, excluding the current run", async () => {
    const session = await setupSession();
    const run1 = await createRun(session.id);
    await updateRunStatus(run1.id, "done", { providerSessionRef: "ref-1" });
    const run2 = await createRun(session.id);

    await expect(getLatestProviderSessionRef(session.id, run2.id)).resolves.toBe("ref-1");
  });

  it("returns undefined when no other run has a provider session ref", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    await expect(getLatestProviderSessionRef(session.id, run.id)).resolves.toBeUndefined();
  });
});

describe("events repository", () => {
  it("persists an event row for a run", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);

    await createEvent(run.id, 1, "text_delta", { text: "Hello" });

    const rows = await db.select().from(events).where(eq(events.runId, run.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 1, type: "text_delta", data: { text: "Hello" } });
  });
});
