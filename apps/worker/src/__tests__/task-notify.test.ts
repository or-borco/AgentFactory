import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, Task } from "@agentfactory/core";

const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
const getConnectionCredentialRefMock = vi.fn<(orgId: number, id: number) => Promise<number | null | undefined>>();
const readConnectionSecretMock = vi.fn<(orgId: number, id: number) => Promise<Record<string, string> | undefined>>();
const setConnectionHealthMock = vi.fn();
const updateTaskMock = vi.fn();

vi.mock("@agentfactory/db", () => ({
  listConnections: (orgId: number) => listConnectionsMock(orgId),
  getConnectionCredentialRef: (orgId: number, id: number) => getConnectionCredentialRefMock(orgId, id),
  readConnectionSecret: (orgId: number, id: number) => readConnectionSecretMock(orgId, id),
  setConnectionHealth: (...args: unknown[]) => setConnectionHealthMock(...args),
  updateTask: (...args: unknown[]) => updateTaskMock(...args),
}));

const addCommentMock = vi.fn<(key: string, body: string) => Promise<void>>();
const createTaskProviderMock = vi.fn();

class FakeProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

vi.mock("@agentfactory/integrations", () => ({
  createTaskProvider: (...args: unknown[]) => createTaskProviderMock(...args),
  ProviderError: FakeProviderError,
}));

const { notifyIssueOfPullRequest } = await import("../task-notify");

const ORG_ID = 1;
const PR = { number: 42, url: "https://github.com/acme/repo/pull/42" };

function jiraConnection(config: Record<string, unknown> = {}): Connection {
  return {
    id: 7,
    orgId: ORG_ID,
    provider: "jira",
    kind: "tasks",
    label: "Jira",
    health: "healthy",
    config: { siteUrl: "https://acme.atlassian.net", accountEmail: "a@acme.com", writeBack: { comment: true }, ...config },
    auth: "api_token",
    createdAt: new Date().toISOString(),
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 99,
    orgId: ORG_ID,
    ref: "T-99",
    title: "Fix the thing",
    description: "",
    acceptanceCriteria: [],
    status: "pr_open",
    createdBy: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function setUpResolvableConnection(config?: Record<string, unknown>): Connection {
  const connection = jiraConnection(config);
  listConnectionsMock.mockResolvedValue([connection]);
  getConnectionCredentialRefMock.mockResolvedValue(55);
  readConnectionSecretMock.mockResolvedValue({ apiToken: "secret-token" });
  createTaskProviderMock.mockReturnValue({ addComment: addCommentMock });
  return connection;
}

describe("notifyIssueOfPullRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("is a no-op when the task has no externalRef", async () => {
    const emitEvent = vi.fn();
    const t = task({ externalRef: undefined });

    await notifyIssueOfPullRequest(ORG_ID, t, PR, emitEvent);

    expect(listConnectionsMock).not.toHaveBeenCalled();
    expect(addCommentMock).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it("posts a comment containing the PR URL and the task ref when a Jira ref is linked", async () => {
    setUpResolvableConnection();
    const emitEvent = vi.fn();
    const t = task({
      externalRef: { provider: "jira", key: "PROJ-1", url: "https://acme.atlassian.net/browse/PROJ-1", lastKnownUpdated: new Date().toISOString() },
    });

    await notifyIssueOfPullRequest(ORG_ID, t, PR, emitEvent);

    expect(addCommentMock).toHaveBeenCalledTimes(1);
    const [key, body] = addCommentMock.mock.calls[0];
    expect(key).toBe("PROJ-1");
    expect(body).toContain(PR.url);
    expect(body).toContain(t.ref);
  });

  it("does not call the provider when writeBack.comment is explicitly false", async () => {
    setUpResolvableConnection({ writeBack: { comment: false } });
    const emitEvent = vi.fn();
    const t = task({
      externalRef: { provider: "jira", key: "PROJ-2", url: "https://acme.atlassian.net/browse/PROJ-2", lastKnownUpdated: new Date().toISOString() },
    });

    await notifyIssueOfPullRequest(ORG_ID, t, PR, emitEvent);

    expect(addCommentMock).not.toHaveBeenCalled();
  });

  it("emits an error event and records writeBackFailure, but never throws, when the provider call fails", async () => {
    setUpResolvableConnection();
    addCommentMock.mockRejectedValue(new FakeProviderError(500, "Atlassian is down"));
    const emitEvent = vi.fn();
    const externalRef = {
      provider: "jira" as const,
      key: "PROJ-3",
      url: "https://acme.atlassian.net/browse/PROJ-3",
      lastKnownUpdated: new Date().toISOString(),
    };
    const t = task({ externalRef });

    await expect(notifyIssueOfPullRequest(ORG_ID, t, PR, emitEvent)).resolves.toBeUndefined();

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [type, data] = emitEvent.mock.calls[0];
    expect(type).toBe("error");
    expect(String((data as Record<string, unknown>).message)).toContain("Atlassian is down");

    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    const [taskId, patch] = updateTaskMock.mock.calls[0];
    expect(taskId).toBe(t.id);
    expect(patch.externalRef.writeBackFailure).toMatchObject({ message: expect.stringContaining("Atlassian is down") });
    expect(patch.externalRef.key).toBe(externalRef.key);

    expect(setConnectionHealthMock).toHaveBeenCalledWith(ORG_ID, 7, "needs-attention");
  });

  it("flips connection health to expired on an auth failure", async () => {
    setUpResolvableConnection();
    addCommentMock.mockRejectedValue(new FakeProviderError(401, "Unauthorized"));
    const t = task({
      externalRef: { provider: "jira", key: "PROJ-4", url: "https://acme.atlassian.net/browse/PROJ-4", lastKnownUpdated: new Date().toISOString() },
    });

    await notifyIssueOfPullRequest(ORG_ID, t, PR, vi.fn());

    expect(setConnectionHealthMock).toHaveBeenCalledWith(ORG_ID, 7, "expired");
  });

  it("on success, leaves writeBackFailure unset and does not falsely mark a fresh write-back as failed", async () => {
    setUpResolvableConnection();
    const emitEvent = vi.fn();
    const t = task({
      externalRef: { provider: "jira", key: "PROJ-5", url: "https://acme.atlassian.net/browse/PROJ-5", lastKnownUpdated: new Date().toISOString() },
    });

    await notifyIssueOfPullRequest(ORG_ID, t, PR, emitEvent);

    expect(emitEvent).not.toHaveBeenCalled();
    // No prior writeBackFailure existed, so nothing needs clearing — no updateTask call for this field.
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it("on success, clears a previously-set writeBackFailure", async () => {
    setUpResolvableConnection();
    const t = task({
      externalRef: {
        provider: "jira",
        key: "PROJ-6",
        url: "https://acme.atlassian.net/browse/PROJ-6",
        lastKnownUpdated: new Date().toISOString(),
        writeBackFailure: { message: "stale failure", occurredAt: new Date().toISOString() },
      },
    });

    await notifyIssueOfPullRequest(ORG_ID, t, PR, vi.fn());

    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    const [taskId, patch] = updateTaskMock.mock.calls[0];
    expect(taskId).toBe(t.id);
    expect(patch.externalRef.writeBackFailure).toBeUndefined();
    expect(patch.externalRef.key).toBe("PROJ-6");
  });
});
