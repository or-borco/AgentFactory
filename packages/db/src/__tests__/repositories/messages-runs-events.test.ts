import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { events } from "../../schema.js";
import { createEvent, listEventsForSession } from "../../repositories/events.js";
import { createMessage, getMessage, listMessages } from "../../repositories/messages.js";
import { createRun, getLatestProviderSessionRef, getRun, getRunPrompt, updateRunStatus } from "../../repositories/runs.js";
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

  it("persists the model that actually executed the run", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    const model = { family: "anthropic" as const, id: "claude-sonnet-5", maxTokens: 8192 };

    const updated = await updateRunStatus(run.id, "done", { finishedAt: new Date(), model });

    expect(updated?.model).toEqual(model);
    await expect(getRun(run.id)).resolves.toMatchObject({ model });
  });

  it("persists the composed prompt's hash", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    const promptHash = "a".repeat(64);

    const updated = await updateRunStatus(run.id, "running", { promptHash });

    expect(updated?.promptHash).toBe(promptHash);
    await expect(getRun(run.id)).resolves.toMatchObject({ promptHash });
  });

  it("stores prompt segments with the status update and reads them back via getRunPrompt only", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    const promptHash = "b".repeat(64);
    const segments = [
      { id: "platform_preamble", text: "You are an agent.\n\n---\n\n" },
      { id: "team_context", text: "", omittedReason: "no_team" as const },
      { id: "agent_system_prompt", text: "You are a reviewer." },
    ];

    await updateRunStatus(run.id, "running", { promptHash, promptSegments: segments });

    await expect(getRunPrompt(run.id)).resolves.toEqual({ runId: run.id, segments, promptHash });
    // Segments must never surface on the Run type — it rides the task page's status polls.
    const fetched = await getRun(run.id);
    expect(fetched).not.toHaveProperty("promptSegments");
  });

  it("returns undefined from getRunPrompt for a missing run and for a run without stored segments", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);

    await expect(getRunPrompt(run.id)).resolves.toBeUndefined();
    await expect(getRunPrompt(999999)).resolves.toBeUndefined();
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

  it("listEventsForSession returns events ordered by run then seq", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);

    await createEvent(run.id, 0, "thinking_delta", { text: "Let me think…" });
    await createEvent(run.id, 1, "tool_call", { tool: "read_file", input: { path: "src/index.ts" } });
    await createEvent(run.id, 2, "tool_result", { tool: "read_file", output: "export {};", isError: false });

    const result = await listEventsForSession(session.id);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ seq: 0, type: "thinking_delta", data: { text: "Let me think…" } });
    expect(result[1]).toMatchObject({ seq: 1, type: "tool_call", data: { tool: "read_file" } });
    expect(result[2]).toMatchObject({ seq: 2, type: "tool_result", data: { tool: "read_file", isError: false } });
    expect(result[0].runId).toBe(run.id);
  });

  it("listEventsForSession returns nothing for a session with no runs", async () => {
    const session = await setupSession();
    await expect(listEventsForSession(session.id)).resolves.toEqual([]);
  });

  it("listEventsForSession does not return events from another session's runs", async () => {
    const sessionA = await setupSession();
    const sessionB = await setupSession();
    const runA = await createRun(sessionA.id);
    await createEvent(runA.id, 0, "text_delta", { text: "Session A event" });

    await expect(listEventsForSession(sessionB.id)).resolves.toEqual([]);
  });
});
