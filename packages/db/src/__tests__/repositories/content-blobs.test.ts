import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { contentBlobs, orgs } from "../../schema.js";
import { getContentBlob, insertContentBlob } from "../../repositories/content-blobs.js";
import { insertOrg } from "../fixtures.js";

// SHA-256 of "# Handbook\n\nUse pnpm.\n" — a real digest, so the fixture stays honest about what
// a content-addressed key actually looks like.
const SHA = "3af3530bc7bee950015f8dd829be57ce3db32743cadaa222c3d8a13433d046ec";

describe("content-blobs repository", () => {
  it("returns undefined for a sha that was never stored", async () => {
    const org = await insertOrg();
    await expect(getContentBlob(org.id, SHA)).resolves.toBeUndefined();
  });

  it("inserts a blob and reads it back by (org, sha)", async () => {
    const org = await insertOrg();
    await insertContentBlob(org.id, SHA, 22, "text/markdown");

    await expect(getContentBlob(org.id, SHA)).resolves.toEqual({
      orgId: org.id,
      sha256: SHA,
      sizeBytes: 22,
      mime: "text/markdown",
    });
  });

  it("is idempotent — re-inserting the same (org, sha) leaves one row and does not throw", async () => {
    const org = await insertOrg();
    await insertContentBlob(org.id, SHA, 22, "text/markdown");
    await insertContentBlob(org.id, SHA, 22, "text/markdown");

    const rows = await db.select().from(contentBlobs).where(eq(contentBlobs.orgId, org.id));
    expect(rows).toHaveLength(1);
  });

  // The partitioning guard. A table keyed on sha256 alone would give these two orgs one shared
  // row, and every conflict action on it is wrong — see the design spec's "Blobs are partitioned
  // by org" decision.
  it("gives two orgs storing identical bytes their own rows", async () => {
    const orgA = await insertOrg();
    const orgB = await insertOrg();
    await insertContentBlob(orgA.id, SHA, 22, "text/markdown");
    await insertContentBlob(orgB.id, SHA, 22, "text/markdown");

    await expect(getContentBlob(orgA.id, SHA)).resolves.toMatchObject({ orgId: orgA.id });
    await expect(getContentBlob(orgB.id, SHA)).resolves.toMatchObject({ orgId: orgB.id });
  });

  // The org_id FK cascade is what makes this table reachable by the test harness's
  // `truncate ... restart identity cascade` (setup.ts truncates orgs, never content_blobs).
  it("cascades away with its org, leaving another org's identical blob intact", async () => {
    const orgA = await insertOrg();
    const orgB = await insertOrg();
    await insertContentBlob(orgA.id, SHA, 22, "text/markdown");
    await insertContentBlob(orgB.id, SHA, 22, "text/markdown");

    await db.delete(orgs).where(eq(orgs.id, orgA.id));

    await expect(getContentBlob(orgA.id, SHA)).resolves.toBeUndefined();
    await expect(getContentBlob(orgB.id, SHA)).resolves.toMatchObject({ orgId: orgB.id });
  });
});
