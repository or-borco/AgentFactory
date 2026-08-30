import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../blob-store";
import { FsBlobStore, resolveBlobDir } from "../fs-blob-store";

// packages/storage/src/__tests__ → up four is the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const BYTES = new TextEncoder().encode("# Handbook\n\nUse pnpm.\n");
const SHA = sha256Hex(BYTES);

describe("resolveBlobDir", () => {
  it("passes an absolute path through untouched", () => {
    expect(resolveBlobDir("/var/lib/agentfactory/blobs")).toBe("/var/lib/agentfactory/blobs");
  });

  // The whole point of the function: apps/web and apps/worker start from different directories,
  // so the same BLOB_DIR string has to name the same directory in both.
  it("resolves a relative path against the repo root, never the process cwd", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/somewhere/else");
    try {
      expect(resolveBlobDir(".blobs")).toBe(path.join(REPO_ROOT, ".blobs"));
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("falls back to the repo-root default when the value is missing or blank", () => {
    expect(resolveBlobDir(undefined)).toBe(path.join(REPO_ROOT, ".blobs"));
    expect(resolveBlobDir("   ")).toBe(path.join(REPO_ROOT, ".blobs"));
  });
});

describe("FsBlobStore", () => {
  let root: string;
  let store: FsBlobStore;

  beforeEach(async () => {
    // Files a local adapter writes are not cleaned by the db harness's TRUNCATE, so every test
    // run gets its own directory.
    root = await mkdtemp(path.join(tmpdir(), "agentfactory-blobs-"));
    store = new FsBlobStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes and reports the digest and size", async () => {
    const result = await store.put(1, BYTES, "text/markdown");
    expect(result).toEqual({ sha256: SHA, sizeBytes: BYTES.byteLength });

    const read = await store.get(1, SHA);
    expect(read).toBeDefined();
    expect(Array.from(read!)).toEqual(Array.from(BYTES));
  });

  it("writes under <root>/<orgId>/<sha[0:2]>/<sha>", async () => {
    await store.put(7, BYTES, "text/markdown");
    const expected = path.join(root, "7", SHA.slice(0, 2), SHA);
    await expect(stat(expected).then((s) => s.isFile())).resolves.toBe(true);
  });

  it("is idempotent within an org — putting identical bytes twice keeps one object", async () => {
    const first = await store.put(1, BYTES, "text/markdown");
    const second = await store.put(1, BYTES, "text/markdown");
    expect(second).toEqual(first);

    const read = await store.get(1, SHA);
    expect(Array.from(read!)).toEqual(Array.from(BYTES));
  });

  // The partitioning guard, at the storage layer this time: identical bytes in two orgs are two
  // objects, so one org's delete can never take the other's content with it.
  it("stores two orgs' identical bytes under separate keys", async () => {
    await store.put(1, BYTES, "text/markdown");
    await expect(store.get(2, SHA)).resolves.toBeUndefined();

    await store.put(2, BYTES, "text/markdown");
    expect(Array.from((await store.get(1, SHA))!)).toEqual(Array.from(BYTES));
    expect(Array.from((await store.get(2, SHA))!)).toEqual(Array.from(BYTES));
  });

  it("returns undefined for a digest that was never stored", async () => {
    await expect(store.get(1, "0".repeat(64))).resolves.toBeUndefined();
  });

  // A hostile digest must never be treated as a path segment. Both a directory-traversal payload
  // and a malformed-but-traversal-free string must throw rather than silently reading (or
  // escaping to) some other location on disk.
  it("throws rather than escaping rootDir for a path-traversal digest", async () => {
    await expect(store.get(1, "../../../../etc/passwd")).rejects.toThrow(/Invalid sha256 digest/);
  });

  it("throws for a digest of the wrong length or with non-hex characters", async () => {
    await expect(store.get(1, "abc")).rejects.toThrow(/Invalid sha256 digest/);
    await expect(store.get(1, "g".repeat(64))).rejects.toThrow(/Invalid sha256 digest/);
    await expect(store.get(1, SHA.toUpperCase())).rejects.toThrow(/Invalid sha256 digest/);
  });
});
