import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import "../setup.js";
import { db } from "../../client.js";
import { contextChunks } from "../../schema.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import {
  createTeamContextItem,
  deleteTeamContextItemForOrg,
} from "../../repositories/team-context-items.js";
import {
  countChunksForItem,
  deleteTeamChunksForItem,
  insertTeamContextChunks,
} from "../../repositories/context-chunks.js";
import { insertOrg, insertTeam } from "../fixtures.js";

const MODEL = "Xenova/bge-small-en-v1.5";

// 384 floats, deterministic and spread across the range so a truncation or a dimension mismatch
// shows up rather than hiding behind zeros.
function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 384 }, (_, i) => Math.sin((seed + 1) * (i + 1)));
}

async function setupItem(title = "Engineering handbook") {
  const org = await insertOrg();
  const team = await insertTeam(org.id);
  const sha256 = `sha-${title}-${org.id}`.padEnd(64, "0");
  await insertContentBlob(org.id, sha256, 1024, "text/markdown");
  const item = await createTeamContextItem({
    teamId: team.id,
    orgId: org.id,
    title,
    sizeBytes: 1024,
    sha256,
    mime: "text/markdown",
  });
  return { org, team, item: item! };
}

describe("context-chunks repository", () => {
  it("inserts chunks and counts them for an item", async () => {
    const { team, item } = await setupItem();

    await insertTeamContextChunks([
      {
        itemId: item.id,
        teamId: team.id,
        chunkIdx: 0,
        text: "Handbook › Deploys\n\nRun pnpm build.",
        embedding: fakeEmbedding(0),
        embeddingModel: MODEL,
      },
      {
        itemId: item.id,
        teamId: team.id,
        chunkIdx: 1,
        text: "Handbook › Deploys › Rollback\n\nRevert the tag.",
        embedding: fakeEmbedding(1),
        embeddingModel: MODEL,
      },
    ]);

    await expect(countChunksForItem(item.id)).resolves.toBe(2);
  });

  it("round-trips a stored embedding within float32 tolerance", async () => {
    const { team, item } = await setupItem();
    const embedding = fakeEmbedding(7);

    await insertTeamContextChunks([
      { itemId: item.id, teamId: team.id, chunkIdx: 0, text: "body", embedding, embeddingModel: MODEL },
    ]);

    const [row] = await db.select().from(contextChunks).where(eq(contextChunks.itemId, item.id));
    expect(row.embedding).toHaveLength(384);
    expect(row.embeddingModel).toBe(MODEL);
    // pgvector stores `real`, so 0.8414709848078965 reads back as 0.84147096. Never toEqual.
    for (const [i, value] of embedding.entries()) {
      expect(row.embedding[i]).toBeCloseTo(value, 5);
    }
  });

  it("is a no-op on an empty batch", async () => {
    const { item } = await setupItem();
    await expect(insertTeamContextChunks([])).resolves.toBeUndefined();
    await expect(countChunksForItem(item.id)).resolves.toBe(0);
  });

  it("deletes only the named item's chunks", async () => {
    const { team, item } = await setupItem("Engineering handbook");
    const second = await setupItem("API design guidelines");
    await insertTeamContextChunks([
      { itemId: item.id, teamId: team.id, chunkIdx: 0, text: "a", embedding: fakeEmbedding(0), embeddingModel: MODEL },
      {
        itemId: second.item.id,
        teamId: second.team.id,
        chunkIdx: 0,
        text: "b",
        embedding: fakeEmbedding(1),
        embeddingModel: MODEL,
      },
    ]);

    await deleteTeamChunksForItem(item.id);

    await expect(countChunksForItem(item.id)).resolves.toBe(0);
    await expect(countChunksForItem(second.item.id)).resolves.toBe(1);
  });

  it("cascades chunks away when the item is deleted", async () => {
    const { org, team, item } = await setupItem();
    await insertTeamContextChunks([
      { itemId: item.id, teamId: team.id, chunkIdx: 0, text: "a", embedding: fakeEmbedding(0), embeddingModel: MODEL },
      { itemId: item.id, teamId: team.id, chunkIdx: 1, text: "b", embedding: fakeEmbedding(1), embeddingModel: MODEL },
    ]);

    await expect(deleteTeamContextItemForOrg(item.id, org.id)).resolves.toBe(true);

    await expect(countChunksForItem(item.id)).resolves.toBe(0);
  });
});
