import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { teams } from "../../schema.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import { insertTeamContextChunks } from "../../repositories/context-chunks.js";
import {
  countIndexedTeamContextItems,
  createTeamContextItem,
  deleteTeamContextItemForOrg,
  getTeamContextItem,
  listTeamContextItemsForOrg,
  markTeamContextItemIndexed,
} from "../../repositories/team-context-items.js";
import { insertOrg, insertTeam, insertUser } from "../fixtures.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const MODEL = "Xenova/bge-small-en-v1.5";

// 384 floats, deterministic — matches the pattern used in context-chunks.test.ts.
function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 384 }, (_, i) => Math.sin((seed + 1) * (i + 1)));
}

// Every item reaches its bytes through the composite (org_id, sha256) FK, so the blob row has to
// exist first — the same order the upload route uses: put the bytes, then insert the item.
async function setupTeamWithBlob(sha = SHA_A) {
  const org = await insertOrg();
  const team = await insertTeam(org.id);
  await insertContentBlob(org.id, sha, 42, "text/markdown");
  return { org, team };
}

describe("team-context-items repository", () => {
  it("creates a pending item and reads it back", async () => {
    const { org, team } = await setupTeamWithBlob();
    const user = await insertUser();

    const item = await createTeamContextItem({
      teamId: team.id,
      orgId: org.id,
      title: "Engineering handbook",
      sizeBytes: 42,
      sha256: SHA_A,
      mime: "text/markdown",
      uploadedBy: user.id,
    });
    if (!item) throw new Error("expected the item to be created");

    expect(item).toMatchObject({
      teamId: team.id,
      orgId: org.id,
      title: "Engineering handbook",
      sizeBytes: 42,
      sha256: SHA_A,
      mime: "text/markdown",
      source: "upload",
      status: "pending",
      uploadedBy: user.id,
    });
    expect(item.error).toBeUndefined();
    expect(item.indexedAt).toBeUndefined();
    await expect(getTeamContextItem(item.id)).resolves.toEqual(item);
  });

  // The route turns this undefined into a 409. Two items over one blob would both match
  // retrieval and spend the byte budget twice on identical text.
  it("returns undefined when the same bytes are uploaded to the same team twice", async () => {
    const { org, team } = await setupTeamWithBlob();
    const first = await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Handbook", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    expect(first).toBeDefined();

    const second = await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Handbook (copy)", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });

    expect(second).toBeUndefined();
    await expect(listTeamContextItemsForOrg(team.id, org.id)).resolves.toHaveLength(1);
  });

  // The unique index is (team_id, sha256), not (org_id, sha256): two teams in one org sharing
  // one handbook is a normal thing to want, and each needs its own retrievable item.
  it("allows the same document in two teams of one org", async () => {
    const { org, team } = await setupTeamWithBlob();
    const other = await insertTeam(org.id, { name: "Other team" });

    await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Handbook", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    const twin = await createTeamContextItem({
      teamId: other.id, orgId: org.id, title: "Handbook", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });

    expect(twin).toBeDefined();
    await expect(listTeamContextItemsForOrg(other.id, org.id)).resolves.toHaveLength(1);
  });

  it("lists items ordered oldest first and only for the given team and org", async () => {
    const { org, team } = await setupTeamWithBlob();
    await insertContentBlob(org.id, SHA_B, 17, "text/plain");
    await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Handbook", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Runbooks", sizeBytes: 17, sha256: SHA_B, mime: "text/plain",
    });

    const items = await listTeamContextItemsForOrg(team.id, org.id);
    expect(items.map((i) => i.title)).toEqual(["Handbook", "Runbooks"]);

    const otherOrg = await insertOrg();
    await expect(listTeamContextItemsForOrg(team.id, otherOrg.id)).resolves.toEqual([]);
  });

  it("deletes an item for its own org and refuses another org's", async () => {
    const { org, team } = await setupTeamWithBlob();
    const otherOrg = await insertOrg();
    const item = await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Cross-org doc", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    if (!item) throw new Error("expected the item to be created");

    await expect(deleteTeamContextItemForOrg(item.id, otherOrg.id)).resolves.toBe(false);
    await expect(listTeamContextItemsForOrg(team.id, org.id)).resolves.toHaveLength(1);

    await expect(deleteTeamContextItemForOrg(item.id, org.id)).resolves.toBe(true);
    await expect(listTeamContextItemsForOrg(team.id, org.id)).resolves.toEqual([]);
  });

  it("cascade-deletes items when the team is deleted", async () => {
    const { org, team } = await setupTeamWithBlob();
    await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Will cascade", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });

    await db.delete(teams).where(eq(teams.id, team.id));

    await expect(listTeamContextItemsForOrg(team.id, org.id)).resolves.toEqual([]);
  });

  // countIndexedTeamContextItems now counts context_chunks, not team_context_items rows, so an
  // "indexed" item only counts once it actually has searchable chunks.
  it("counts chunks, not indexed items, and only for the given team", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    const otherTeam = await insertTeam(org.id);

    await insertContentBlob(org.id, "a".repeat(64), 128, "text/markdown");
    await insertContentBlob(org.id, "b".repeat(64), 128, "text/markdown");
    await insertContentBlob(org.id, "c".repeat(64), 128, "text/markdown");
    const indexed = await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Handbook", sizeBytes: 128,
      sha256: "a".repeat(64), mime: "text/markdown",
    });
    await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Still pending", sizeBytes: 128,
      sha256: "b".repeat(64), mime: "text/markdown",
    });
    const otherTeamItem = await createTeamContextItem({
      teamId: otherTeam.id, orgId: org.id, title: "Other team handbook", sizeBytes: 128,
      sha256: "c".repeat(64), mime: "text/markdown",
    });

    await expect(countIndexedTeamContextItems(team.id)).resolves.toBe(0);

    await markTeamContextItemIndexed(indexed!.id);
    await markTeamContextItemIndexed(otherTeamItem!.id);
    await insertTeamContextChunks([
      {
        itemId: indexed!.id,
        teamId: team.id,
        chunkIdx: 0,
        text: "Handbook › Deploys\n\nRun pnpm build.",
        embedding: fakeEmbedding(0),
        embeddingModel: MODEL,
      },
    ]);
    await insertTeamContextChunks([
      {
        itemId: otherTeamItem!.id,
        teamId: otherTeam.id,
        chunkIdx: 0,
        text: "Other team handbook › Intro\n\nWelcome.",
        embedding: fakeEmbedding(1),
        embeddingModel: MODEL,
      },
    ]);

    await expect(countIndexedTeamContextItems(team.id)).resolves.toBe(1);
  });

  it("counts zero for a team with no items at all", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    await expect(countIndexedTeamContextItems(team.id)).resolves.toBe(0);
  });

  // The whole point of the fix: an item marked "indexed" that produced zero chunks (e.g. an
  // empty or whitespace-only upload) must not make the team look searchable.
  it("counts zero when the only item is indexed but has no chunks", async () => {
    const { org, team } = await setupTeamWithBlob();
    const item = await createTeamContextItem({
      teamId: team.id, orgId: org.id, title: "Empty upload", sizeBytes: 42,
      sha256: SHA_A, mime: "text/markdown",
    });
    await markTeamContextItemIndexed(item!.id);

    await expect(countIndexedTeamContextItems(team.id)).resolves.toBe(0);
  });
});
