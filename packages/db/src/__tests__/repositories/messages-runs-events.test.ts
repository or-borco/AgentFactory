import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { events } from "../../schema.js";
import { createEvent, listEventsForSession } from "../../repositories/events.js";
import { createMessage, getFinalAssistantMessageForRun, getMessage, listMessages } from "../../repositories/messages.js";
import {
  createRun,
  getLatestResumeCandidate,
  getRun,
  getRunPrompt,
  updateRunCommitRange,
  updateRunStatus,
} from "../../repositories/runs.js";
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

  // No prior test asserted ordering at all (just presence/length) — this was a real gap: without
  // an explicit ORDER BY, row order isn't guaranteed by Postgres, and callers like session context
  // reconstruction depend on chronological order to know which messages are "most recent" for
  // truncation.
  it("lists messages chronologically, oldest first", async () => {
    const session = await setupSession();
    const first = await createMessage(session.id, "user", "first");
    const second = await createMessage(session.id, "assistant", "second");
    const third = await createMessage(session.id, "user", "third");

    await expect(listMessages(session.id)).resolves.toEqual([first, second, third]);
  });

  it("links an assistant message to the run that produced it", async () => {
    const session = await setupSession();
    const userMessage = await createMessage(session.id, "user", "Please review PR 1234");
    const run = await createRun(session.id, userMessage.id);
    const assistantMessage = await createMessage(session.id, "assistant", "Looks good", run.id);

    expect(assistantMessage.runId).toBe(run.id);
    await expect(listMessages(session.id)).resolves.toHaveLength(2);
  });

  it("returns the final assistant message for a run", async () => {
    const session = await setupSession();
    const userMessage = await createMessage(session.id, "user", "Do the thing");
    const run = await createRun(session.id, userMessage.id);
    await createMessage(session.id, "assistant", "First draft", run.id);
    const final = await createMessage(session.id, "assistant", "Final answer", run.id);
    await createMessage(session.id, "user", "Unrelated follow-up");

    await expect(getFinalAssistantMessageForRun(run.id)).resolves.toEqual(final);
  });

  it("returns undefined when the run produced no assistant message", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    await expect(getFinalAssistantMessageForRun(run.id)).resolves.toBeUndefined();
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
      sandboxId: "sandbox-1",
    });

    expect(updated).toMatchObject({ status: "done", providerSessionRef: "provider-ref-1", sandboxId: "sandbox-1" });
    await expect(getRun(run.id)).resolves.toMatchObject({ status: "done" });
  });

  it("finds the latest completed run's provider session ref and the sandbox it was recorded against", async () => {
    const session = await setupSession();
    const run1 = await createRun(session.id);
    await updateRunStatus(run1.id, "done", { providerSessionRef: "ref-1", sandboxId: "sandbox-1" });
    const run2 = await createRun(session.id);

    await expect(getLatestResumeCandidate(session.id, run2.id)).resolves.toEqual({
      providerSessionRef: "ref-1",
      sandboxId: "sandbox-1",
    });
  });

  it("returns undefined when no other run has a provider session ref", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    await expect(getLatestResumeCandidate(session.id, run.id)).resolves.toBeUndefined();
  });

  // The regression this repository function exists to fix: a run's own providerSessionRef can
  // predate this column (sandboxId undefined) or can have been recorded against a sandbox that
  // has since been torn down and replaced — the caller (worker.ts) is the one that compares this
  // against the session's CURRENT sandboxId, but this function must faithfully return whatever
  // was actually recorded, including "no sandboxId at all", rather than silently coercing it to
  // something that would accidentally compare as valid.
  it("returns sandboxId as undefined for a run recorded before that column existed", async () => {
    const session = await setupSession();
    const run1 = await createRun(session.id);
    // No sandboxId in the patch — simulates a historical row, or a run whose provider session
    // ref was set without one for any other reason.
    await updateRunStatus(run1.id, "done", { providerSessionRef: "ref-1" });
    const run2 = await createRun(session.id);

    await expect(getLatestResumeCandidate(session.id, run2.id)).resolves.toEqual({
      providerSessionRef: "ref-1",
      sandboxId: undefined,
    });
  });

  it("round-trips the commit range a run pushed", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    expect(run.commitRange).toBeUndefined();

    await updateRunCommitRange(run.id, { baseSha: "a".repeat(40), headSha: "b".repeat(40) });

    await expect(getRun(run.id)).resolves.toMatchObject({
      commitRange: { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
    });
  });

  it("leaves the commit range unset for a run that pushed nothing", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    await updateRunStatus(run.id, "done", { finishedAt: new Date() });

    await expect(getRun(run.id)).resolves.toMatchObject({ commitRange: undefined });
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

  it("returns promptHash undefined, not an empty string, when segments are stored without a hash", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    const segments = [{ id: "agent_system_prompt", text: "You are a reviewer." }];

    await updateRunStatus(run.id, "running", { promptSegments: segments });

    await expect(getRunPrompt(run.id)).resolves.toEqual({ runId: run.id, segments, promptHash: undefined });
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

  // Guards the fix for the "no DB indexes" issue: the events -> runs join behind
  // listEventsForSession is on the task page's ~1.5s poll, and events is append-only and only
  // ever grows. This must stay an index scan, not a sequential scan of the whole table.
  //
  // Gotcha: on a near-empty table Postgres correctly *prefers* a seq scan regardless of what
  // indexes exist, because it's genuinely cheaper at that size — so a naive EXPLAIN here would
  // fail even with the index in place. Rather than seed thousands of rows to out-run the
  // planner's own heuristic (slow, and still not guaranteed across environments), this disables
  // the seq scan method for the assertion, the same technique used in
  // context-chunks-search.test.ts for the same reason. That's a meaningful check, not a
  // tautology: with `enable_seqscan = off`, Postgres still has to fall back to a seq scan if no
  // usable index exists at all — it isn't forbidden, just deprioritized. So this test fails
  // before events_run_id_seq_idx / runs_session_id_idx exist and passes once they do.
  it("uses an index scan, not a seq scan, for the session-events join", async () => {
    const target = await setupSession();
    const targetRun = await createRun(target.id);
    await createEvent(targetRun.id, 0, "text_delta", { text: "target 1" });
    await createEvent(targetRun.id, 1, "text_delta", { text: "target 2" });

    // Decoy data in other sessions/runs, so a correctness regression (e.g. a bad join) would
    // actually be caught by the assertion below, not just this table being otherwise empty.
    const decoySession = await setupSession();
    const decoyRun = await createRun(decoySession.id);
    await createEvent(decoyRun.id, 0, "text_delta", { text: "decoy" });

    await db.execute(sql`set enable_seqscan = off`);
    try {
      const plan = await db.execute<{ "QUERY PLAN": string }>(
        sql`explain select e.id, e.run_id, e.seq, e.type, e.data
            from events e
            inner join runs r on e.run_id = r.id
            where r.session_id = ${target.id}
            order by e.run_id, e.seq`,
      );
      const planText = Array.from(plan)
        .map((row) => row["QUERY PLAN"])
        .join("\n");

      expect(planText).toMatch(/Index Scan/);
      expect(planText).not.toMatch(/Seq Scan/);
    } finally {
      await db.execute(sql`set enable_seqscan = on`);
    }

    // Correctness alongside the plan assertion, so an index change can't silently alter which
    // rows come back.
    const rows = await listEventsForSession(target.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.data)).toEqual([{ text: "target 1" }, { text: "target 2" }]);
  });
});
