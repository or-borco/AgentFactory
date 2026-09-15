import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalAttachment } from "@agentfactory/integrations";

const requireAuthContext = vi.fn();
const createTask = vi.fn();
const listTasks = vi.fn();
const enqueueRepoMapWarmJob = vi.fn();
const insertContentBlob = vi.fn();
const createTaskContextItem = vi.fn();
const enqueueTaskContextIngestJob = vi.fn();
const resolveTaskProvider = vi.fn();
const blobPut = vi.fn();
const fetchAttachment = vi.fn();

// The real @agentfactory/db throws at import when DATABASE_URL is unset (client.ts), and
// @agentfactory/queue does the same without REDIS_URL — factory mocks keep both from loading.
vi.mock("@agentfactory/db", () => ({
  createTask: (...args: unknown[]) => createTask(...args),
  listTasks: (...args: unknown[]) => listTasks(...args),
  insertContentBlob: (...args: unknown[]) => insertContentBlob(...args),
  createTaskContextItem: (...args: unknown[]) => createTaskContextItem(...args),
}));
vi.mock("@agentfactory/queue", () => ({
  enqueueRepoMapWarmJob: (...args: unknown[]) => enqueueRepoMapWarmJob(...args),
  enqueueTaskContextIngestJob: (...args: unknown[]) => enqueueTaskContextIngestJob(...args),
}));
vi.mock("@agentfactory/storage", () => ({
  createBlobStore: () => ({ put: (...args: unknown[]) => blobPut(...args) }),
}));
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContext() }));
vi.mock("@/server/task-provider", () => ({
  resolveTaskProvider: (...args: unknown[]) => resolveTaskProvider(...args),
}));

import { POST } from "../route";

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(body) }),
  );
}

beforeEach(() => {
  requireAuthContext.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  createTask.mockReset();
  listTasks.mockReset();
  enqueueRepoMapWarmJob.mockReset().mockResolvedValue(undefined);
  insertContentBlob.mockReset();
  createTaskContextItem.mockReset();
  enqueueTaskContextIngestJob.mockReset().mockResolvedValue(undefined);
  resolveTaskProvider.mockReset();
  blobPut.mockReset();
  fetchAttachment.mockReset();
});

describe("POST /api/tasks", () => {
  it("401s without creating anything or touching the queue", async () => {
    requireAuthContext.mockResolvedValue(undefined);

    const res = await post({ title: "T" });

    expect(res.status).toBe(401);
    expect(createTask).not.toHaveBeenCalled();
    expect(enqueueRepoMapWarmJob).not.toHaveBeenCalled();
  });

  // The one-line omission behind task T-070's missing repo map: every other entry point that can
  // set a codebase warms the cache, and task creation — the most common one — did not.
  it("warms the repo map when the task is created with a codebase", async () => {
    createTask.mockResolvedValue({ id: 70, orgId: 3, codebase: "erakauf1/transcriber" });

    const res = await post({ title: "Add retries", codebase: "erakauf1/transcriber" });

    expect(res.status).toBe(201);
    expect(enqueueRepoMapWarmJob).toHaveBeenCalledExactlyOnceWith(3, "erakauf1/transcriber");
  });

  it("does not warm anything for a task with no codebase", async () => {
    createTask.mockResolvedValue({ id: 71, orgId: 3, codebase: undefined });

    const res = await post({ title: "Write a doc" });

    expect(res.status).toBe(201);
    expect(enqueueRepoMapWarmJob).not.toHaveBeenCalled();
  });

  // Best-effort, exactly like the other call sites: a Redis outage must not turn a successful
  // task creation into a 500. A missed warm only means the next run pays generation, as today.
  it("still returns 201 when the queue is down", async () => {
    createTask.mockResolvedValue({ id: 72, orgId: 3, codebase: "acme/widgets" });
    enqueueRepoMapWarmJob.mockRejectedValue(new Error("redis down"));

    const res = await post({ title: "Add retries", codebase: "acme/widgets" });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: 72 });
  });

  // The warm is scoped by the created task's own org, not by anything the request body supplied.
  it("warms against the task's org rather than a caller-supplied one", async () => {
    createTask.mockResolvedValue({ id: 73, orgId: 3, codebase: "acme/widgets" });

    await post({ title: "T", codebase: "acme/widgets", orgId: 999 });

    expect(enqueueRepoMapWarmJob).toHaveBeenCalledExactlyOnceWith(3, "acme/widgets");
  });

  it("rejects an invalid model id before creating or warming", async () => {
    const res = await post({ title: "T", codebase: "acme/widgets", model: { id: "not-a-model" } });

    expect(res.status).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
    expect(enqueueRepoMapWarmJob).not.toHaveBeenCalled();
  });

  // The attachment-ingest block (below) has no mime gate of its own — unlike the manual upload
  // route, it accepts whatever mime the linked issue reports and lets the shared ingest pipeline
  // decide what to do with it. This proves an image attachment is not silently dropped or
  // rejected here: it reaches the blob store and task_context_items exactly like any other
  // attachment, tagged source: "jira", so the image-upload feature's ingest/materialization
  // changes (which key off item.mime alone) already apply to it once ingestion runs.
  describe("attachment ingestion from a linked issue", () => {
    function imageAttachment(overrides: Partial<ExternalAttachment> = {}): ExternalAttachment {
      return {
        filename: "screenshot.png",
        mime: "image/png",
        sizeBytes: 4,
        contentUrl: "https://example.atlassian.net/attachment/1",
        ...overrides,
      };
    }

    beforeEach(() => {
      createTask.mockResolvedValue({ id: 80, orgId: 3, externalRef: "PROJ-1", codebase: undefined });
      resolveTaskProvider.mockResolvedValue({
        connection: { id: 1 },
        provider: { fetchAttachment: (...args: unknown[]) => fetchAttachment(...args) },
      });
      fetchAttachment.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      blobPut.mockResolvedValue({ sha256: "a".repeat(64), sizeBytes: 4 });
      createTaskContextItem.mockResolvedValue({ id: 900 });
    });

    it("ingests an image attachment exactly like any other mime — no gate rejects it", async () => {
      const res = await post({
        title: "From issue",
        externalRef: "PROJ-1",
        attachments: [imageAttachment()],
      });

      expect(res.status).toBe(201);
      expect(blobPut).toHaveBeenCalledWith(3, expect.any(Uint8Array), "image/png");
      expect(insertContentBlob).toHaveBeenCalledWith(3, "a".repeat(64), 4, "image/png");
      expect(createTaskContextItem).toHaveBeenCalledWith({
        taskId: 80,
        orgId: 3,
        title: "screenshot.png",
        sizeBytes: 4,
        sha256: "a".repeat(64),
        mime: "image/png",
        source: "jira",
      });
      expect(enqueueTaskContextIngestJob).toHaveBeenCalledWith(900);
    });

    it("skips an oversized image attachment without failing task creation", async () => {
      const res = await post({
        title: "From issue",
        externalRef: "PROJ-1",
        attachments: [imageAttachment({ sizeBytes: 3 * 1024 * 1024 })],
      });

      expect(res.status).toBe(201);
      expect(fetchAttachment).not.toHaveBeenCalled();
      expect(createTaskContextItem).not.toHaveBeenCalled();
    });
  });
});
