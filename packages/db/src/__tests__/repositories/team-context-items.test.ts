import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { teams } from "../../schema.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import {
  createTeamContextItem,
  deleteTeamContextItemForOrg,
  getTeamContextItem,
  listTeamContextItemsForOrg,
} from "../../repositories/team-context-items.js";
import { insertOrg, insertTeam, insertUser } from "../fixtures.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

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
});
