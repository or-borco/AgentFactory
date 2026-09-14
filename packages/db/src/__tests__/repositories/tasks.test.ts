import type { TaskExternalRef } from "@agentfactory/core";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { attachTaskSession, createTask, getTaskBySessionId, updateTask } from "../../repositories/tasks.js";
import { insertAgent, insertOrg, insertSession, insertTask, insertUser } from "../fixtures.js";

describe("getTaskBySessionId", () => {
  it("finds the task attached to a session", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const agent = await insertAgent(org.id);
    const session = await insertSession(org.id, agent.id);
    const task = await insertTask(org.id, user.id, { codebase: "acme-org/platform" });
    await attachTaskSession(task.id, session.id);

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
