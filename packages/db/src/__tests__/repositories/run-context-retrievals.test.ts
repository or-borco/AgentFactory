import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { runs, taskContextItems, teamContextItems } from "../../schema.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import {
  insertRunContextRetrievals,
  listRunContextRetrievals,
} from "../../repositories/run-context-retrievals.js";
import { createRun } from "../../repositories/runs.js";
import { deleteTaskContextItemForOrg } from "../../repositories/task-context-items.js";
import {
  createTeamContextItem,
  deleteTeamContextItemForOrg,
} from "../../repositories/team-context-items.js";
import { insertAgent, insertOrg, insertSession, insertTask, insertTeam, insertUser } from "../fixtures.js";

async function setup() {
  const org = await insertOrg();
  const team = await insertTeam(org.id);
  const agent = await insertAgent(org.id, { teamId: team.id });
  const session = await insertSession(org.id, agent.id);
  const run = await createRun(session.id);
  await insertContentBlob(org.id, "a".repeat(64), 128, "text/markdown");
  const item = await createTeamContextItem({
    teamId: team.id, orgId: org.id, title: "Engineering handbook", sizeBytes: 128,
    sha256: "a".repeat(64), mime: "text/markdown",
  });
  return { org, run, item: item! };
}

describe("run-context-retrievals repository", () => {
  it("stores what was retrieved and lists it back in rank order", async () => {
    const { run, item } = await setup();

    await insertRunContextRetrievals([
      { runId: run.id, itemId: item.id, itemTitle: item.title, chunkIdx: 7, rank: 2, score: 0.61 },
      { runId: run.id, itemId: item.id, itemTitle: item.title, chunkIdx: 3, rank: 1, score: 0.84 },
    ]);

    const rows = await listRunContextRetrievals(run.id);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      runId: run.id,
      itemId: item.id,
      itemTitle: "Engineering handbook",
      chunkIdx: 3,
      rank: 1,
      score: 0.84,
    });
    expect(rows[0].createdAt).toBeDefined();
  });

  it("inserting an empty array is a no-op rather than an error", async () => {
    const { run } = await setup();
    await insertRunContextRetrievals([]);
    await expect(listRunContextRetrievals(run.id)).resolves.toEqual([]);
  });

  // Provenance must survive the document. The retrieved text itself is already preserved
  // verbatim in runs.prompt_segments; this row is what still says where it came from.
  // item_id has no DB-level FK any more (see the cross-scope test below for why), so this
  // null-out is deleteTeamContextItemForOrg's own application-level replacement for the old
  // ON DELETE SET NULL.
  it("keeps the title snapshot and nulls item_id when the document is deleted", async () => {
    const { org, run, item } = await setup();
    await insertRunContextRetrievals([
      { runId: run.id, itemId: item.id, itemTitle: item.title, chunkIdx: 0, rank: 1, score: 0.9 },
    ]);

    await expect(deleteTeamContextItemForOrg(item.id, org.id)).resolves.toBe(true);

    const [row] = await listRunContextRetrievals(run.id);
    expect(row.itemId).toBeUndefined();
    expect(row.itemTitle).toBe("Engineering handbook");
  });

  it("is cascade-deleted with its run", async () => {
    const { run, item } = await setup();
    await insertRunContextRetrievals([
      { runId: run.id, itemId: item.id, itemTitle: item.title, chunkIdx: 0, rank: 1, score: 0.9 },
    ]);

    await db.delete(runs).where(eq(runs.id, run.id));

    await expect(listRunContextRetrievals(run.id)).resolves.toEqual([]);
  });

  // The reason item_id can't be a DB-level FK any more: team_context_items and task_context_items
  // are two independent identity sequences, so a team item and a task item can land on the exact
  // same numeric id. item_kind is what a reader (and each delete path) must use to tell them
  // apart — forcing the collision explicitly here, rather than hoping test ordering produces one,
  // is what actually exercises that.
  it("disambiguates a team item and a task item sharing the same numeric id, with no cross-contamination", async () => {
    const org = await insertOrg();
    const user = await insertUser();
    const team = await insertTeam(org.id);
    const agent = await insertAgent(org.id, { teamId: team.id });
    const session = await insertSession(org.id, agent.id);
    const run = await createRun(session.id);
    const task = await insertTask(org.id, user.id);
    await insertContentBlob(org.id, "a".repeat(64), 128, "text/markdown");

    const SHARED_ID = 4242;
    const [teamItem] = await db
      .insert(teamContextItems)
      .values({
        id: SHARED_ID, teamId: team.id, orgId: org.id, title: "Team handbook", sizeBytes: 128,
        sha256: "a".repeat(64), mime: "text/markdown",
      })
      .returning();
    const [taskItem] = await db
      .insert(taskContextItems)
      .values({
        id: SHARED_ID, taskId: task.id, orgId: org.id, title: "Task spec", sizeBytes: 128,
        sha256: "a".repeat(64), mime: "text/markdown",
      })
      .returning();
    expect(taskItem.id).toBe(teamItem.id);

    await insertRunContextRetrievals([
      {
        runId: run.id, itemId: teamItem.id, itemKind: "team", itemTitle: teamItem.title,
        chunkIdx: 0, rank: 1, score: 0.9,
      },
      {
        runId: run.id, itemId: taskItem.id, itemKind: "task", itemTitle: taskItem.title,
        chunkIdx: 0, rank: 2, score: 0.8,
      },
    ]);

    // Deleting the team item must null only the item_kind: "team" row, even though the task
    // item shares its numeric id.
    await expect(deleteTeamContextItemForOrg(teamItem.id, org.id)).resolves.toBe(true);
    let rows = await listRunContextRetrievals(run.id);
    expect(rows.find((r) => r.itemKind === "team")?.itemId).toBeUndefined();
    expect(rows.find((r) => r.itemKind === "task")?.itemId).toBe(taskItem.id);

    // Deleting the task item must null only the item_kind: "task" row (already-nulled team row
    // is unaffected either way).
    await expect(deleteTaskContextItemForOrg(taskItem.id, org.id)).resolves.toBe(true);
    rows = await listRunContextRetrievals(run.id);
    expect(rows.find((r) => r.itemKind === "team")?.itemId).toBeUndefined();
    expect(rows.find((r) => r.itemKind === "task")?.itemId).toBeUndefined();
  });
});
