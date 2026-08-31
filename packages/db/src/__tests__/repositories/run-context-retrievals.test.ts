import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { runs } from "../../schema.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import {
  insertRunContextRetrievals,
  listRunContextRetrievals,
} from "../../repositories/run-context-retrievals.js";
import { createRun } from "../../repositories/runs.js";
import {
  createTeamContextItem,
  deleteTeamContextItemForOrg,
} from "../../repositories/team-context-items.js";
import { insertAgent, insertOrg, insertSession, insertTeam } from "../fixtures.js";

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
});
