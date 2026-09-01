import { describe, expect, it } from "vitest";
import "../setup.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import {
  createTaskContextItem,
  getTaskContextItem,
  markTaskContextItemFailed,
  markTaskContextItemIndexed,
  markTaskContextItemIndexing,
} from "../../repositories/task-context-items.js";
import { insertOrg, insertTask, insertUser } from "../fixtures.js";

const SHA = "a".repeat(64);

async function setupItem() {
  const org = await insertOrg();
  const user = await insertUser();
  const task = await insertTask(org.id, user.id);
  // task_context_items carries a composite FK to (content_blobs.org_id, sha256), so the blob has
  // to exist before the item can.
  await insertContentBlob(org.id, SHA, 42, "text/markdown");
  const item = await createTaskContextItem({
    taskId: task.id,
    orgId: org.id,
    title: "Design doc",
    sizeBytes: 42,
    sha256: SHA,
    mime: "text/markdown",
  });
  if (!item) throw new Error("fixture item was not created");
  return { org, task, item };
}

describe("task context item status transitions", () => {
  it("starts a freshly created item at pending with no error and no indexedAt", async () => {
    const { item } = await setupItem();

    expect(item.status).toBe("pending");
    expect(item.error).toBeUndefined();
    expect(item.indexedAt).toBeUndefined();
  });

  it("moves pending → indexing", async () => {
    const { item } = await setupItem();

    await markTaskContextItemIndexing(item.id);

    await expect(getTaskContextItem(item.id)).resolves.toMatchObject({ status: "indexing" });
  });

  it("moves indexing → indexed and stamps indexedAt", async () => {
    const { item } = await setupItem();

    await markTaskContextItemIndexing(item.id);
    await markTaskContextItemIndexed(item.id);

    const indexed = await getTaskContextItem(item.id);
    expect(indexed?.status).toBe("indexed");
    expect(indexed?.indexedAt).toBeDefined();
    expect(indexed?.error).toBeUndefined();
  });

  it("records the message on failure", async () => {
    const { item } = await setupItem();

    await markTaskContextItemIndexing(item.id);
    await markTaskContextItemFailed(item.id, "Unsupported mime type: application/pdf");

    const failed = await getTaskContextItem(item.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("Unsupported mime type: application/pdf");
    expect(failed?.indexedAt).toBeUndefined();
  });

  // A stalled redelivery re-runs a job that already failed once. If the stale message survived
  // the retry, the panel would render "Indexed" with a failure line underneath it.
  it("clears a previous error when a re-ingest succeeds", async () => {
    const { item } = await setupItem();

    await markTaskContextItemFailed(item.id, "Blob a… is missing from the blob store");
    await markTaskContextItemIndexing(item.id);
    expect((await getTaskContextItem(item.id))?.error).toBeUndefined();

    await markTaskContextItemIndexed(item.id);
    const indexed = await getTaskContextItem(item.id);
    expect(indexed?.status).toBe("indexed");
    expect(indexed?.error).toBeUndefined();
  });
});
