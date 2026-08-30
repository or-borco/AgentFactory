import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(command: unknown) {
      return sendMock(command);
    }
  },
  PutObjectCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

const { createBlobStore, sha256Hex } = await import("../index");

const BYTES = new TextEncoder().encode("# Handbook\n\nUse pnpm.\n");
const SHA = sha256Hex(BYTES);

describe("createBlobStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "agentfactory-blobs-"));
    sendMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to a filesystem store rooted at BLOB_DIR", async () => {
    vi.stubEnv("BLOB_STORE", "");
    vi.stubEnv("BLOB_DIR", root);

    await createBlobStore().put(7, BYTES, "text/markdown");

    const expected = path.join(root, "7", SHA.slice(0, 2), SHA);
    await expect(stat(expected).then((s) => s.isFile())).resolves.toBe(true);
  });

  it("builds an S3-backed store when BLOB_STORE=s3", async () => {
    vi.stubEnv("BLOB_STORE", "s3");
    vi.stubEnv("S3_BUCKET", "agentfactory-blobs");
    sendMock.mockResolvedValue({});

    await createBlobStore().put(7, BYTES, "text/markdown");

    expect(sendMock.mock.calls[0][0].input).toMatchObject({
      Bucket: "agentfactory-blobs",
      Key: `7/${SHA.slice(0, 2)}/${SHA}`,
    });
  });

  // Failing loudly at construction beats a store that silently puts nowhere.
  it("throws when BLOB_STORE=s3 but S3_BUCKET is missing", () => {
    vi.stubEnv("BLOB_STORE", "s3");
    vi.stubEnv("S3_BUCKET", "");

    expect(() => createBlobStore()).toThrow(/S3_BUCKET/);
  });

  it("throws on an unrecognised BLOB_STORE value", () => {
    vi.stubEnv("BLOB_STORE", "gcs");

    expect(() => createBlobStore()).toThrow(/gcs/);
  });

  // Read at call time, not at import time — otherwise the value freezes on first import and the
  // two host processes can never be configured independently.
  it("reads the environment on every call, not at module load", async () => {
    vi.stubEnv("BLOB_STORE", "fs");
    vi.stubEnv("BLOB_DIR", root);
    await createBlobStore().put(1, BYTES, "text/markdown");

    vi.stubEnv("BLOB_STORE", "s3");
    vi.stubEnv("S3_BUCKET", "agentfactory-blobs");
    sendMock.mockResolvedValue({});
    await createBlobStore().put(1, BYTES, "text/markdown");

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
