import type { TaskExternalRef } from "@agentfactory/core";
import { describe, expect, it } from "vitest";
import "../setup.js";
import {
  createTask,
  getTaskBySessionId,
  startTaskSession,
  updateTask,
} from "../../repositories/tasks.js";
import { insertAgent, insertOrg, insertSession, insertTask, insertUser } from "../fixtures.js";

describe("getTaskBySessionId", () => {
  it("finds the task attached to a session", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);
    const task = await insertTask(org.id, user.id, { codebase: "acme-org/platform" });
    await updateTask(task.id, { sessionId: session.id, status: "in_progress" });

    const found = await getTaskBySessionId(session.id);

    expect(found?.id).toBe(task.id);
    expect(found?.codebase).toBe("acme-org/platform");
  });

  it("returns undefined for a session with no attached task", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);

    await expect(getTaskBySessionId(session.id)).resolves.toBeUndefined();
  });
});

describe("updateTask", () => {
  it("stores prNumber, prUrl, and status together after a draft PR is opened", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const task = await insertTask(org.id, user.id, { codebase: "acme-org/platform" });

    const updated = await updateTask(task.id, {
      prNumber: 7,
      prUrl: "https://github.com/acme-org/platform/pull/7",
      status: "pr_open",
    });

    expect(updated).toMatchObject({
      prNumber: 7,
      prUrl: "https://github.com/acme-org/platform/pull/7",
      status: "pr_open",
    });
  });
});

describe("externalRef", () => {
  const ref: TaskExternalRef = {
    provider: "jira",
    key: "PROJ-123",
    url: "https://acme.atlassian.net/browse/PROJ-123",
    lastKnownUpdated: "2026-09-01T00:00:00.000Z",
  };

  it("is undefined when unset", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const task = await insertTask(org.id, user.id);

    expect(task.externalRef).toBeUndefined();
  });

  it("round-trips through create", async () => {
    const org = await insertOrg();
    const user = await insertUser();

    const task = await createTask(org.id, user.id, {
      title: "Fix login bug",
      description: "",
      acceptanceCriteria: [],
      externalRef: ref,
    });

    expect(task.externalRef).toEqual(ref);
  });

  it("round-trips through update", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const task = await insertTask(org.id, user.id);

    const updated = await updateTask(task.id, { externalRef: ref });

    expect(updated.externalRef).toEqual(ref);
  });
});

describe("startTaskSession", () => {
  it("creates a session and the first user message, and updates the task in one write", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const agent = await insertAgent(org.id);
    const task = await insertTask(org.id, user.id, { title: "Fix the thing" });

    const result = await startTaskSession(task.id, org.id, agent.id, task.title, "Fix the thing please", {
      origin: "telegram",
      externalThreadRef: "42",
    });

    expect(result.started).toBe(true);
    if (!result.started) throw new Error("expected started: true");
    expect(result.session.agentId).toBe(agent.id);
    expect(result.session.origin).toBe("telegram");
    expect(result.session.externalThreadRef).toBe("42");
    expect(result.task.sessionId).toBe(result.session.id);
    expect(result.task.assigneeAgentId).toBe(agent.id);
    expect(result.task.status).toBe("in_progress");

    const { listMessages } = await import("../../repositories/messages.js");
    const messages = await listMessages(result.session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Fix the thing please");
    expect(messages[0].id).toBe(result.userMessageId);
  });

  it("bumps the task's updatedAt", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const agent = await insertAgent(org.id);
    const task = await insertTask(org.id, user.id);
    const before = task.updatedAt;

    await new Promise((r) => setTimeout(r, 5));
    const result = await startTaskSession(task.id, org.id, agent.id, task.title, "brief", { origin: "telegram" });

    if (!result.started) throw new Error("expected started: true");
    expect(new Date(result.task.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("returns started: false without creating a session when the task already has one", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const agent = await insertAgent(org.id);
    const task = await insertTask(org.id, user.id);
    const first = await startTaskSession(task.id, org.id, agent.id, task.title, "brief", { origin: "telegram" });
    if (!first.started) throw new Error("expected first call to start");

    const second = await startTaskSession(task.id, org.id, agent.id, task.title, "a different brief", { origin: "telegram" });

    expect(second.started).toBe(false);
    if (second.started) throw new Error("expected started: false");
    expect(second.task.sessionId).toBe(first.session.id);
    expect(second.task.assigneeAgentId).toBe(agent.id);
  });

  it("throws when the task belongs to a different org", async () => {
    const org = await insertOrg();
    const otherOrg = await insertOrg();
    const user = await insertUser();
    const agent = await insertAgent(otherOrg.id);
    const task = await insertTask(org.id, user.id);

    await expect(
      startTaskSession(task.id, otherOrg.id, agent.id, task.title, "brief", { origin: "telegram" }),
    ).rejects.toThrow(/does not belong to org/);
  });

  it("throws when the task does not exist", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);

    await expect(
      startTaskSession(999_999, org.id, agent.id, "title", "brief", { origin: "telegram" }),
    ).rejects.toThrow(/not found/);
  });

  it("under real concurrency, exactly one caller starts the task and the loser creates no rows", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const agentA = await insertAgent(org.id);
    const agentB = await insertAgent(org.id);
    const task = await insertTask(org.id, user.id);

    // Without this, `task.updatedAt` (captured immediately after insert) and the winner's
    // post-`startTaskSession` `updatedAt` can land in the same millisecond, making the final
    // `toBeGreaterThan` assertion below flaky — same pattern as Task 5's "bumps the task's
    // updatedAt" test.
    await new Promise((r) => setTimeout(r, 5));

    const [resultA, resultB] = await Promise.all([
      startTaskSession(task.id, org.id, agentA.id, task.title, "brief A", { origin: "telegram", externalThreadRef: "A" }),
      startTaskSession(task.id, org.id, agentB.id, task.title, "brief B", { origin: "telegram", externalThreadRef: "B" }),
    ]);

    const outcomes = [resultA, resultB];
    const winners = outcomes.filter((r) => r.started);
    const losers = outcomes.filter((r) => !r.started);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winner = winners[0];
    if (!winner.started) throw new Error("expected a winner");
    const loser = losers[0];

    // The loser's own returned task reflects the actual winning agent — no window where
    // task.assigneeAgentId and the running session's agentId can disagree.
    expect(loser.task.assigneeAgentId).toBe(winner.task.assigneeAgentId);
    expect(loser.task.sessionId).toBe(winner.session.id);

    // No orphan rows: exactly one session and one message exist for this task, not two.
    const { listSessions } = await import("../../repositories/sessions.js");
    const allSessions = await listSessions(org.id);
    const sessionsForThisTask = allSessions.filter((s) => s.id === winner.session.id || s.externalThreadRef === "A" || s.externalThreadRef === "B");
    expect(sessionsForThisTask).toHaveLength(1);

    const { listMessages } = await import("../../repositories/messages.js");
    const messagesInWinningSession = await listMessages(winner.session.id);
    expect(messagesInWinningSession).toHaveLength(1);

    // The winning task's updatedAt genuinely advanced past its pre-call value.
    expect(new Date(winner.task.updatedAt).getTime()).toBeGreaterThan(new Date(task.updatedAt).getTime());
  });
});
