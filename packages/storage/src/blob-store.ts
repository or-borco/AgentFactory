import { createHash } from "node:crypto";

// The port every blob adapter implements. Deliberately two methods and no delete: blob garbage
// collection is out of scope (blobs may be shared between items within an org, and nothing
// reclaims them yet — see the design spec's "Out of scope").
//
// orgId is part of every key, not a convenience: two orgs uploading the same bytes must never
// contend for one object, which mirrors content_blobs' (org_id, sha256) primary key.
export interface BlobStore {
  // Content-addressed, so putting identical bytes twice within an org is a no-op by construction
  // and the port is idempotent without the caller doing anything.
  put(orgId: number, bytes: Uint8Array, mime: string): Promise<{ sha256: string; sizeBytes: number }>;
  // undefined — not a throw — when the org has no object under that digest.
  get(orgId: number, sha256: string): Promise<Uint8Array | undefined>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
