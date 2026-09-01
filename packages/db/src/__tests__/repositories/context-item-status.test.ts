import { describe, expect, it } from "vitest";
import "../setup.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import {
  createTeamContextItem,
  getTeamContextItem,
  markTeamContextItemFailed,
  markTeamContextItemIndexed,
  markTeamContextItemIndexing,
} from "../../repositories/team-context-items.js";
import { insertOrg, insertTeam } from "../fixtures.js";

const SHA = "a".repeat(64);

async function setupItem() {
  const org = await insertOrg();
  const team = await insertTeam(org.id);
  // team_context_items carries a composite FK to (content_blobs.org_id, sha256), so the blob
  // has to exist before the item can.
  await insertContentBlob(org.id, SHA, 42, "text/markdown");
  const item = await createTeamContextItem({
    teamId: team.id,
    orgId: org.id,
    title: "Engineering handbook",
    sizeBytes: 42,
    sha256: SHA,
    mime: "text/markdown",
  });
  if (!item) throw new Error("fixture item was not created");
  return { org, team, item };
}

describe("context item status transitions", () => {
  it("starts a freshly created item at pending with no error and no indexedAt", async () => {
    const { item } = await setupItem();

    expect(item.status).toBe("pending");
    expect(item.error).toBeUndefined();
    expect(item.indexedAt).toBeUndefined();
  });

  it("moves pending → indexing", async () => {
    const { item } = await setupItem();

    await markTeamContextItemIndexing(item.id);

    await expect(getTeamContextItem(item.id)).resolves.toMatchObject({ status: "indexing" });
  });

  it("moves indexing → indexed and stamps indexedAt", async () => {
    const { item } = await setupItem();

    await markTeamContextItemIndexing(item.id);
    await markTeamContextItemIndexed(item.id);

    const indexed = await getTeamContextItem(item.id);
    expect(indexed?.status).toBe("indexed");
    expect(indexed?.indexedAt).toBeDefined();
    expect(indexed?.error).toBeUndefined();
  });

  it("records the message on failure", async () => {
    const { item } = await setupItem();

    await markTeamContextItemIndexing(item.id);
    await markTeamContextItemFailed(item.id, "Unsupported mime type: application/pdf");

    const failed = await getTeamContextItem(item.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("Unsupported mime type: application/pdf");
    expect(failed?.indexedAt).toBeUndefined();
  });

  // A stalled redelivery re-runs a job that already failed once. If the stale message survived
  // the retry, the panel would render "Indexed" with a failure line underneath it.
  it("clears a previous error when a re-ingest succeeds", async () => {
    const { item } = await setupItem();

    await markTeamContextItemFailed(item.id, "Blob a… is missing from the blob store");
    await markTeamContextItemIndexing(item.id);
    expect((await getTeamContextItem(item.id))?.error).toBeUndefined();

    await markTeamContextItemIndexed(item.id);
    const indexed = await getTeamContextItem(item.id);
    expect(indexed?.status).toBe("indexed");
    expect(indexed?.error).toBeUndefined();
  });
});
