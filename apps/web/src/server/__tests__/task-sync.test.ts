import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskExternalRef } from "@agentfactory/core";
import type { ExternalIssue } from "@agentfactory/integrations";

const resolveTaskProviderMock = vi.fn();
vi.mock("../task-provider", () => ({
  resolveTaskProvider: (...args: unknown[]) => resolveTaskProviderMock(...args),
}));

import { checkTaskSync } from "../task-sync";

const externalRef: TaskExternalRef = {
  provider: "jira",
  key: "PROJ-123",
  url: "https://example.atlassian.net/browse/PROJ-123",
  lastKnownUpdated: "2026-09-01T00:00:00.000Z",
};

const baseTask: Task = {
  id: 1,
  orgId: 3,
  ref: "T-001",
  title: "Fix the thing",
  description: "",
  acceptanceCriteria: [],
  status: "open",
  createdBy: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function issue(overrides: Partial<ExternalIssue> = {}): ExternalIssue {
  return {
    key: "PROJ-123",
    title: "Fix the thing",
    description: "Updated description",
    status: "In Progress",
    issueType: "Task",
    labels: [],
    url: externalRef.url,
    attachments: [],
    updated: externalRef.lastKnownUpdated,
    ...overrides,
  };
}

const fetchIssue = vi.fn();
const providerHandle = { connection: { id: 1 } as unknown, provider: { fetchIssue } };

beforeEach(() => {
  resolveTaskProviderMock.mockReset().mockResolvedValue(providerHandle);
  fetchIssue.mockReset();
});

describe("checkTaskSync", () => {
  it("is not stale when the task has no externalRef, and never calls the provider", async () => {
    const result = await checkTaskSync(3, { ...baseTask, externalRef: undefined });

    expect(result).toEqual({ stale: false });
    expect(resolveTaskProviderMock).not.toHaveBeenCalled();
  });

  it("is not stale when the org has no tasks connection", async () => {
    resolveTaskProviderMock.mockResolvedValue(undefined);

    const result = await checkTaskSync(3, { ...baseTask, externalRef });

    expect(result).toEqual({ stale: false });
  });

  // The case that matters most: a Jira outage must never be mistaken for "run refused," only
  // ever for "nothing to worry about" — Design decision 12.
  it("fails open when fetchIssue throws, instead of throwing itself", async () => {
    fetchIssue.mockRejectedValue(new Error("Jira is down"));

    const result = await checkTaskSync(3, { ...baseTask, externalRef });

    expect(result).toEqual({ stale: false });
  });

  it("is not stale when the issue's updated timestamp is unchanged", async () => {
    fetchIssue.mockResolvedValue(issue({ updated: externalRef.lastKnownUpdated }));

    const result = await checkTaskSync(3, { ...baseTask, externalRef });

    expect(result).toEqual({ stale: false });
  });

  it("is stale when the issue's updated timestamp has moved, and returns the latest issue", async () => {
    const latest = issue({ updated: "2026-09-10T00:00:00.000Z" });
    fetchIssue.mockResolvedValue(latest);

    const result = await checkTaskSync(3, { ...baseTask, externalRef });

    expect(result).toEqual({ stale: true, latest });
  });

  it("is not stale when fetchIssue returns undefined (issue deleted upstream)", async () => {
    fetchIssue.mockResolvedValue(undefined);

    const result = await checkTaskSync(3, { ...baseTask, externalRef });

    expect(result).toEqual({ stale: false });
  });
});
