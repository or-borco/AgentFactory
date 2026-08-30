import { type BlobStore } from "./blob-store";
import { FsBlobStore, resolveBlobDir } from "./fs-blob-store";
import { S3BlobStore } from "./s3-blob-store";

export * from "./blob-store";
export * from "./fs-blob-store";
export * from "./s3-blob-store";

// The one place an adapter is chosen. Callers (the upload route, the ingest worker) hold the
// result for the life of the process rather than calling this per request.
//
// Env is read here, on every call, and never at module scope: a module-body read would freeze the
// value at import time — see packages/db/src/client.ts:5-8 for what that costs in test ergonomics.
export function createBlobStore(): BlobStore {
  const kind = process.env.BLOB_STORE?.trim() || "fs";

  if (kind === "fs") {
    return new FsBlobStore(resolveBlobDir(process.env.BLOB_DIR));
  }

  if (kind === "s3") {
    const bucket = process.env.S3_BUCKET?.trim();
    if (!bucket) {
      throw new Error("BLOB_STORE=s3 requires S3_BUCKET to name the bucket.");
    }
    return new S3BlobStore(bucket);
  }

  throw new Error(`Unknown BLOB_STORE "${kind}" — expected "fs" or "s3".`);
}
