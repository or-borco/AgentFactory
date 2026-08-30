import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BlobStore, sha256Hex } from "./blob-store";

const DEFAULT_BLOB_DIR = ".blobs";

// packages/storage/src → up three is the repo root. Derived from this module's own URL, never
// from process.cwd(): apps/web and apps/worker are separate host processes started from their own
// package directories, and a cwd-relative BLOB_DIR would silently give them two directories.
// Same technique as packages/db/src/__tests__/setup.ts:9-13.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveBlobDir(value: string | undefined): string {
  const raw = value?.trim() ? value.trim() : DEFAULT_BLOB_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
}

// The dev and single-host default. Fans out on the first two hex characters so one org's blob
// directory does not become a single flat directory with tens of thousands of entries.
export class FsBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {}

  async put(
    orgId: number,
    bytes: Uint8Array,
    // Unused here — the content type is recorded on the content_blobs row, not on the file. It
    // stays in the signature because S3BlobStore sets it as object metadata.
    mime: string,
  ): Promise<{ sha256: string; sizeBytes: number }> {
    void mime;
    const sha256 = sha256Hex(bytes);
    const file = this.pathFor(orgId, sha256);
    await mkdir(path.dirname(file), { recursive: true });
    // Content-addressed, so a re-put writes byte-identical content to the same path — idempotent
    // without a read-check, and safe under the ingest worker's retries.
    await writeFile(file, bytes);
    return { sha256, sizeBytes: bytes.byteLength };
  }

  async get(orgId: number, sha256: string): Promise<Uint8Array | undefined> {
    try {
      // Copied out of the Buffer so callers never hold a view into Node's pooled allocations.
      return new Uint8Array(await readFile(this.pathFor(orgId, sha256)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private pathFor(orgId: number, sha256: string): string {
    return path.join(this.rootDir, String(orgId), sha256.slice(0, 2), sha256);
  }
}
