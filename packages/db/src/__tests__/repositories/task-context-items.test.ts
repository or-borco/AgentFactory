import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { tasks } from "../../schema.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import { insertTaskContextChunks } from "../../repositories/task-context-chunks.js";
import {
  countIndexedTaskContextItems,
  createTaskContextItem,
  deleteTaskContextItemForOrg,
  getTaskContextItem,
  listTaskContextItemsForOrg,
  markTaskContextItemIndexed,
} from "../../repositories/task-context-items.js";
import { insertOrg, insertTask, insertUser } from "../fixtures.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const MODEL = "Xenova/bge-small-en-v1.5";

// 384 floats, deterministic — matches the pattern used in task-context-chunks.test.ts.
function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 384 }, (_, i) => Math.sin((seed + 1) * (i + 1)));
}

// Every item reaches its bytes through the composite (org_id, sha256) FK, so the blob row has to
// exist first — the same order the upload route uses: put the bytes, then insert the item.
async function setupTaskWithBlob(sha = SHA_A) {
  const org = await insertOrg();
  const user = await insertUser();
  const task = await insertTask(org.id, user.id);
  await insertContentBlob(org.id, sha, 42, "text/markdown");
  return { org, user, task };
}

describe("task-context-items repository", () => {
  it("creates a pending item and reads it back", async () => {
    const { org, task, user } = await setupTaskWithBlob();

    const item = await createTaskContextItem({
      taskId: task.id,
      orgId: org.id,
      title: "Design doc",
      sizeBytes: 42,
      sha256: SHA_A,
      mime: "text/markdown",
      uploadedBy: user.id,
    });
    if (!item) throw new Error("expected the item to be created");

    expect(item).toMatchObject({
      taskId: task.id,
      orgId: org.id,
      title: "Design doc",
      sizeBytes: 42,
      sha256: SHA_A,
      mime: "text/markdown",
      source: "upload",
      status: "pending",
      uploadedBy: user.id,
    });
    expect(item.error).toBeUndefined();
    expect(item.indexedAt).toBeUndefined();
    await expect(getTaskContextItem(item.id)).resolves.toEqual(item);
  });

  // Accepting `source` as repository input is the only DB-side change attachments need
  // (jira-integration-design.md, Design decision 9): a later PR tags Jira-derived items
  // `source: "jira"`, unrelated to the ingestion logic exercised elsewhere in this file.
  it("stores and returns a caller-provided source", async () => {
    const { org, task, user } = await setupTaskWithBlob();

    const item = await createTaskContextItem({
      taskId: task.id,
      orgId: org.id,
      title: "Issue attachment",
      sizeBytes: 42,
      sha256: SHA_A,
      mime: "text/markdown",
      uploadedBy: user.id,
      source: "jira",
    });

    expect(item?.source).toBe("jira");
    await expect(getTaskContextItem(item!.id)).resolves.toMatchObject({ source: "jira" });
  });

  // Regression guard: omitting `source` must still fall through to the column's own "upload"
  // default, exactly as it did before NewTaskContextItem accepted the field.
  it("defaults source to upload when not specified", async () => {
    const { org, task } = await setupTaskWithBlob();

    const item = await createTaskContextItem({
      taskId: task.id,
      orgId: org.id,
      title: "Design doc",
      sizeBytes: 42,
      sha256: SHA_A,
      mime: "text/markdown",
    });

    expect(item?.source).toBe("upload");
  });

  // The route turns this undefined into a 409. Two items over one blob would both match
  // retrieval and spend the byte budget twice on identical text.
  it("returns undefined when the same bytes are uploaded to the same task twice", async () => {
    const { org, task } = await setupTaskWithBlob();
    const first = await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Spec", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    expect(first).toBeDefined();

    const second = await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Spec (copy)", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });

    expect(second).toBeUndefined();
    await expect(listTaskContextItemsForOrg(task.id, org.id)).resolves.toHaveLength(1);
  });

  // The unique index is (task_id, sha256), not (org_id, sha256): two tasks in one org sharing one
  // spec is a normal thing to want, and each needs its own retrievable item.
  it("allows the same document on two tasks of one org", async () => {
    const { org, task, user } = await setupTaskWithBlob();
    const other = await insertTask(org.id, user.id, { title: "Other task" });

    await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Spec", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    const twin = await createTaskContextItem({
      taskId: other.id, orgId: org.id, title: "Spec", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });

    expect(twin).toBeDefined();
    await expect(listTaskContextItemsForOrg(other.id, org.id)).resolves.toHaveLength(1);
  });

  it("lists items ordered oldest first and only for the given task and org", async () => {
    const { org, task } = await setupTaskWithBlob();
    await insertContentBlob(org.id, SHA_B, 17, "text/plain");
    await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Spec", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Notes", sizeBytes: 17, sha256: SHA_B, mime: "text/plain",
    });

    const items = await listTaskContextItemsForOrg(task.id, org.id);
    expect(items.map((i) => i.title)).toEqual(["Spec", "Notes"]);

    const otherOrg = await insertOrg();
    await expect(listTaskContextItemsForOrg(task.id, otherOrg.id)).resolves.toEqual([]);
  });

  it("deletes an item for its own org and refuses another org's", async () => {
    const { org, task } = await setupTaskWithBlob();
    const otherOrg = await insertOrg();
    const item = await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Cross-org doc", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    if (!item) throw new Error("expected the item to be created");

    await expect(deleteTaskContextItemForOrg(item.id, otherOrg.id)).resolves.toBe(false);
    await expect(listTaskContextItemsForOrg(task.id, org.id)).resolves.toHaveLength(1);

    await expect(deleteTaskContextItemForOrg(item.id, org.id)).resolves.toBe(true);
    await expect(listTaskContextItemsForOrg(task.id, org.id)).resolves.toEqual([]);
  });

  it("cascade-deletes items when the task is deleted", async () => {
    const { org, task } = await setupTaskWithBlob();
    await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Will cascade", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });

    await db.delete(tasks).where(eq(tasks.id, task.id));

    await expect(listTaskContextItemsForOrg(task.id, org.id)).resolves.toEqual([]);
  });

  // countIndexedTaskContextItems counts task_context_chunks, not task_context_items rows, so an
  // "indexed" item only counts once it actually has searchable chunks.
  it("counts chunks, not indexed items, and only for the given task", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const task = await insertTask(org.id, user.id);
    const otherTask = await insertTask(org.id, user.id, { title: "Other task" });

    await insertContentBlob(org.id, "a".repeat(64), 128, "text/markdown");
    await insertContentBlob(org.id, "b".repeat(64), 128, "text/markdown");
    await insertContentBlob(org.id, "c".repeat(64), 128, "text/markdown");
    const indexed = await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Spec", sizeBytes: 128,
      sha256: "a".repeat(64), mime: "text/markdown",
    });
    await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Still pending", sizeBytes: 128,
      sha256: "b".repeat(64), mime: "text/markdown",
    });
    const otherTaskItem = await createTaskContextItem({
      taskId: otherTask.id, orgId: org.id, title: "Other task spec", sizeBytes: 128,
      sha256: "c".repeat(64), mime: "text/markdown",
    });

    await expect(countIndexedTaskContextItems(task.id)).resolves.toBe(0);

    await markTaskContextItemIndexed(indexed!.id);
    await markTaskContextItemIndexed(otherTaskItem!.id);
    await insertTaskContextChunks([
      {
        itemId: indexed!.id,
        taskId: task.id,
        chunkIdx: 0,
        text: "Spec › Rollout\n\nShip behind a flag.",
        embedding: fakeEmbedding(0),
        embeddingModel: MODEL,
      },
    ]);
    await insertTaskContextChunks([
      {
        itemId: otherTaskItem!.id,
        taskId: otherTask.id,
        chunkIdx: 0,
        text: "Other task spec › Intro\n\nWelcome.",
        embedding: fakeEmbedding(1),
        embeddingModel: MODEL,
      },
    ]);

    await expect(countIndexedTaskContextItems(task.id)).resolves.toBe(1);
  });

  it("counts zero for a task with no items at all", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const task = await insertTask(org.id, user.id);
    await expect(countIndexedTaskContextItems(task.id)).resolves.toBe(0);
  });

  // The whole point of the fix, mirrored from team_context_items: an item marked "indexed" that
  // produced zero chunks (e.g. an empty or whitespace-only upload) must not make the task look
  // searchable.
  it("counts zero when the only item is indexed but has no chunks", async () => {
    const { org, task } = await setupTaskWithBlob();
    const item = await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Empty upload", sizeBytes: 42,
      sha256: SHA_A, mime: "text/markdown",
    });
    await markTaskContextItemIndexed(item!.id);

    await expect(countIndexedTaskContextItems(task.id)).resolves.toBe(0);
  });
});
