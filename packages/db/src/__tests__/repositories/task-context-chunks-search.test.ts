import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// Same regression-guard rationale as context-chunks-search.test.ts: the planner-forcing SET
// statements below and searchTaskContextChunks' own internal db.transaction() must land on the
// exact same physical connection, which a pooled client with no `max` can't promise. Replacing
// the db client for this whole file with a { max: 1 } pool removes the ambiguity structurally.
vi.mock("../../client.js", async () => {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const schema = await import("../../schema.js");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const queryClient = postgres(connectionString, { max: 1 });
  return { db: drizzle(queryClient, { schema }) };
});

import "../setup.js";
import { db } from "../../client.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import { insertTaskContextChunks, searchTaskContextChunks } from "../../repositories/task-context-chunks.js";
import { createTaskContextItem } from "../../repositories/task-context-items.js";
import { insertOrg, insertTask, insertUser } from "../fixtures.js";

const DIMENSIONS = 384;
const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

// Unit vectors in the plane spanned by the first two axes, so cosine distance is exactly the
// angle: 0 rad sits on top of the query (distance 0), π/2 is orthogonal to it (distance 1).
function planeVector(angleRad: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[0] = Math.cos(angleRad);
  v[1] = Math.sin(angleRad);
  return v;
}

const QUERY = planeVector(0);

async function seedItem(orgId: number, taskId: number, title: string, shaSeed: string) {
  const sha256 = shaSeed.repeat(64).slice(0, 64);
  await insertContentBlob(orgId, sha256, 128, "text/markdown");
  const item = await createTaskContextItem({
    taskId, orgId, title, sizeBytes: 128, sha256, mime: "text/markdown",
  });
  if (!item) throw new Error(`fixture item ${sha256} unexpectedly conflicted`);
  return item;
}

async function seedChunks(
  itemId: number,
  taskId: number,
  total: number,
  angleFor: (i: number) => number,
) {
  for (let start = 0; start < total; start += 200) {
    const rows = [];
    for (let i = start; i < Math.min(start + 200, total); i++) {
      rows.push({
        itemId,
        taskId,
        chunkIdx: i,
        text: `chunk ${i} of item ${itemId}`,
        embedding: planeVector(angleFor(i)),
        embeddingModel: EMBEDDING_MODEL,
      });
    }
    await insertTaskContextChunks(rows);
  }
}

async function newTask(orgId: number, title: string) {
  const user = await insertUser();
  return insertTask(orgId, user.id, { title });
}

describe("searchTaskContextChunks", () => {
  // THE REGRESSION GUARD, mirrored from context-chunks-search.test.ts: hnsw.ef_search defaults to
  // 40, so a tenant-filtered top-k silently under-returns unless `set local hnsw.iterative_scan =
  // 'relaxed_order'` is in effect inside searchTaskContextChunks' transaction. The fixture makes
  // that failure total: two noisy tasks sit directly on the query vector and own 2 000 of the
  // 2 040 rows, so every one of the ~40 global candidates belongs to them.
  it("returns exactly the requested number of rows for a task that owns none of the global top-k", async () => {
    const org = await insertOrg();
    const target = await newTask(org.id, "Target task");
    const noisyA = await newTask(org.id, "Noise task A");
    const noisyB = await newTask(org.id, "Noise task B");

    const targetItem = await seedItem(org.id, target.id, "Target spec", "a");
    const noisyItemA = await seedItem(org.id, noisyA.id, "Noise A doc", "b");
    const noisyItemB = await seedItem(org.id, noisyB.id, "Noise B doc", "c");

    await seedChunks(noisyItemA.id, noisyA.id, 1000, (i) => i * 1e-6);
    await seedChunks(noisyItemB.id, noisyB.id, 1000, (i) => 1e-3 + i * 1e-6);
    await seedChunks(targetItem.id, target.id, 40, (i) => Math.PI / 2 - i * 1e-4);
    // Without stats the planner may pick a sequential scan, which would pass this test for the
    // wrong reason. Analyzing is what makes the HNSW index the chosen plan.
    await db.execute(sql`analyze task_context_chunks`);

    // Same planner-forcing rationale as the team-scoped test: at this fixture's row count the
    // cost estimator prefers task_context_chunks_task_id_idx plus a top-N sort even after
    // ANALYZE. Disabling the competing scan methods forces the HNSW index, so this test actually
    // exercises the same code path production traffic hits at realistic table sizes.
    await db.execute(sql`set enable_seqscan = off`);
    await db.execute(sql`set enable_bitmapscan = off`);
    await db.execute(sql`set enable_indexscan = off`);
    try {
      const matches = await searchTaskContextChunks(target.id, QUERY, 10);

      expect(matches).toHaveLength(10);
      expect(new Set(matches.map((m) => m.itemId))).toEqual(new Set([targetItem.id]));
    } finally {
      await db.execute(sql`set enable_seqscan = on`);
      await db.execute(sql`set enable_bitmapscan = on`);
      await db.execute(sql`set enable_indexscan = on`);
    }
  });

  // relaxed_order buys recall by allowing candidates back slightly out of order, so the outer
  // ORDER BY in searchTaskContextChunks is what makes the persisted rank mean anything.
  it("returns matches sorted by descending similarity", async () => {
    const org = await insertOrg();
    const task = await newTask(org.id, "Task");
    const item = await seedItem(org.id, task.id, "Spec", "d");
    await seedChunks(item.id, task.id, 60, (i) => (i % 60) * 0.02);

    const matches = await searchTaskContextChunks(task.id, QUERY, 10);

    const scores = matches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBeGreaterThan(scores[scores.length - 1]);
    // pgvector stores real (float32), so similarity is asserted with a tolerance, never equality.
    expect(scores[0]).toBeCloseTo(1, 4);
  });

  it("joins the owning document's title and never returns another task's chunk", async () => {
    const org = await insertOrg();
    const mine = await newTask(org.id, "Mine");
    const theirs = await newTask(org.id, "Theirs");
    const myItem = await seedItem(org.id, mine.id, "Incident runbook", "e");
    const theirItem = await seedItem(org.id, theirs.id, "Their runbook", "f");
    await seedChunks(myItem.id, mine.id, 3, () => 0.1);
    await seedChunks(theirItem.id, theirs.id, 3, () => 0);

    const matches = await searchTaskContextChunks(mine.id, QUERY, 10);

    expect(matches).toHaveLength(3);
    expect(matches.every((m) => m.itemTitle === "Incident runbook")).toBe(true);
    expect(matches.every((m) => m.itemId === myItem.id)).toBe(true);
    expect(matches.map((m) => m.chunkIdx).sort()).toEqual([0, 1, 2]);
  });

  // The cross-org guard, mirrored from the team-scoped test: task_context_items is org-scoped by
  // its denormalized org_id, and a search keyed by another org's task id must never leak rows.
  it("is unreachable across orgs: an org A task id never resolves org B's chunks under org A's check", async () => {
    const orgA = await insertOrg();
    const orgB = await insertOrg();
    const taskB = await newTask(orgB.id, "Org B task");
    const itemB = await seedItem(orgB.id, taskB.id, "Org B runbook", "9");
    await seedChunks(itemB.id, taskB.id, 5, () => 0);

    const userA = await insertUser();
    const taskA = await insertTask(orgA.id, userA.id, { title: "Org A task" });

    await expect(searchTaskContextChunks(taskA.id, QUERY, 10)).resolves.toEqual([]);
    await expect(searchTaskContextChunks(taskB.id, QUERY, 10)).resolves.toHaveLength(5);
  });

  it("returns an empty array for a task with no chunks", async () => {
    const org = await insertOrg();
    const task = await newTask(org.id, "Empty task");
    await expect(searchTaskContextChunks(task.id, QUERY, 10)).resolves.toEqual([]);
  });
});
