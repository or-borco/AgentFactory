import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import "../setup.js";
import { db } from "../../client.js";
import { taskContextChunks } from "../../schema.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import {
  createTaskContextItem,
  deleteTaskContextItemForOrg,
} from "../../repositories/task-context-items.js";
import {
  countChunksForTaskItem,
  deleteTaskChunksForItem,
  insertTaskContextChunks,
} from "../../repositories/task-context-chunks.js";
import { insertOrg, insertTask, insertUser } from "../fixtures.js";

const MODEL = "Xenova/bge-small-en-v1.5";

// 384 floats, deterministic and spread across the range so a truncation or a dimension mismatch
// shows up rather than hiding behind zeros.
function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 384 }, (_, i) => Math.sin((seed + 1) * (i + 1)));
}

async function setupItem(title = "Design doc") {
  const org = await insertOrg();
  const user = await insertUser();
  const task = await insertTask(org.id, user.id, { title });
  const sha256 = `sha-${title}-${org.id}`.padEnd(64, "0");
  await insertContentBlob(org.id, sha256, 1024, "text/markdown");
  const item = await createTaskContextItem({
    taskId: task.id,
    orgId: org.id,
    title,
    sizeBytes: 1024,
    sha256,
    mime: "text/markdown",
  });
  return { org, task, item: item! };
}

describe("task-context-chunks repository", () => {
  it("inserts chunks and counts them for an item", async () => {
    const { task, item } = await setupItem();

    await insertTaskContextChunks([
      {
        itemId: item.id,
        taskId: task.id,
        chunkIdx: 0,
        text: "Design doc › Rollout\n\nShip behind a flag.",
        embedding: fakeEmbedding(0),
        embeddingModel: MODEL,
      },
      {
        itemId: item.id,
        taskId: task.id,
        chunkIdx: 1,
        text: "Design doc › Rollout › Rollback\n\nRevert the flag.",
        embedding: fakeEmbedding(1),
        embeddingModel: MODEL,
      },
    ]);

    await expect(countChunksForTaskItem(item.id)).resolves.toBe(2);
  });

  it("round-trips a stored embedding within float32 tolerance", async () => {
    const { task, item } = await setupItem();
    const embedding = fakeEmbedding(7);

    await insertTaskContextChunks([
      { itemId: item.id, taskId: task.id, chunkIdx: 0, text: "body", embedding, embeddingModel: MODEL },
    ]);

    const [row] = await db.select().from(taskContextChunks).where(eq(taskContextChunks.itemId, item.id));
    expect(row.embedding).toHaveLength(384);
    expect(row.embeddingModel).toBe(MODEL);
    // pgvector stores `real`, so 0.8414709848078965 reads back as 0.84147096. Never toEqual.
    for (const [i, value] of embedding.entries()) {
      expect(row.embedding[i]).toBeCloseTo(value, 5);
    }
  });

  it("is a no-op on an empty batch", async () => {
    const { item } = await setupItem();
    await expect(insertTaskContextChunks([])).resolves.toBeUndefined();
    await expect(countChunksForTaskItem(item.id)).resolves.toBe(0);
  });

  it("deletes only the named item's chunks", async () => {
    const { task, item } = await setupItem("Design doc");
    const second = await setupItem("API design guidelines");
    await insertTaskContextChunks([
      { itemId: item.id, taskId: task.id, chunkIdx: 0, text: "a", embedding: fakeEmbedding(0), embeddingModel: MODEL },
      {
        itemId: second.item.id,
        taskId: second.task.id,
        chunkIdx: 0,
        text: "b",
        embedding: fakeEmbedding(1),
        embeddingModel: MODEL,
      },
    ]);

    await deleteTaskChunksForItem(item.id);

    await expect(countChunksForTaskItem(item.id)).resolves.toBe(0);
    await expect(countChunksForTaskItem(second.item.id)).resolves.toBe(1);
  });

  it("cascades chunks away when the item is deleted", async () => {
    const { org, task, item } = await setupItem();
    await insertTaskContextChunks([
      { itemId: item.id, taskId: task.id, chunkIdx: 0, text: "a", embedding: fakeEmbedding(0), embeddingModel: MODEL },
      { itemId: item.id, taskId: task.id, chunkIdx: 1, text: "b", embedding: fakeEmbedding(1), embeddingModel: MODEL },
    ]);

    await expect(deleteTaskContextItemForOrg(item.id, org.id)).resolves.toBe(true);

    await expect(countChunksForTaskItem(item.id)).resolves.toBe(0);
  });
});
