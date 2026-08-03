import { describe, expect, it } from "vitest";
import "../setup.js";
import { attachTaskSession, getTaskBySessionId, updateTask } from "../../repositories/tasks.js";
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
