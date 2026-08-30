import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { contentBlobs } from "../schema";

// Not part of @agentfactory/core: nothing outside the upload route and the ingest worker reads a
// blob row, the same reasoning as RepoMap in repositories/repo-maps.ts.

// No-ops on a re-upload of identical bytes within the org. Content addressing makes that the
// correct outcome — the row already describes exactly these bytes — and it keeps the write path
// idempotent, which the ingest worker's retries depend on. The conflict target is spelled out
// rather than left implicit so it is obvious the key is the composite one, not the hash alone.
export async function insertContentBlob(
  orgId: number,
  sha256: string,
  sizeBytes: number,
  mime: string,
): Promise<void> {
  await db
    .insert(contentBlobs)
    .values({ orgId, sha256, sizeBytes, mime })
    .onConflictDoNothing({ target: [contentBlobs.orgId, contentBlobs.sha256] });
}

export async function getContentBlob(
  orgId: number,
  sha256: string,
): Promise<{ sha256: string; orgId: number; sizeBytes: number; mime: string } | undefined> {
  const [row] = await db
    .select()
    .from(contentBlobs)
    .where(and(eq(contentBlobs.orgId, orgId), eq(contentBlobs.sha256, sha256)));
  return row
    ? { sha256: row.sha256, orgId: row.orgId, sizeBytes: row.sizeBytes, mime: row.mime }
    : undefined;
}
