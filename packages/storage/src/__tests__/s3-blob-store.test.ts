import { beforeEach, describe, expect, it, vi } from "vitest";

// The SDK is replaced wholesale so this stays a unit test with no credentials and no network,
// the same technique apps/worker/src/__tests__/repo-map.test.ts uses for @agentfactory/db.
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

// Dynamic imports so the mock factory is registered before the module under test evaluates.
const { S3BlobStore } = await import("../s3-blob-store");
const { sha256Hex } = await import("../blob-store");

const BYTES = new TextEncoder().encode("# Handbook\n\nUse pnpm.\n");
const SHA = sha256Hex(BYTES);

describe("S3BlobStore", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("puts at <orgId>/<sha[0:2]>/<sha> with the mime as ContentType", async () => {
    sendMock.mockResolvedValue({});
    const store = new S3BlobStore("agentfactory-blobs");

    const result = await store.put(7, BYTES, "text/markdown");

    expect(result).toEqual({ sha256: SHA, sizeBytes: BYTES.byteLength });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input).toEqual({
      Bucket: "agentfactory-blobs",
      Key: `7/${SHA.slice(0, 2)}/${SHA}`,
      Body: BYTES,
      ContentType: "text/markdown",
    });
  });

  it("gets the bytes back from the streaming body", async () => {
    sendMock.mockResolvedValue({ Body: { transformToByteArray: async () => BYTES } });
    const store = new S3BlobStore("agentfactory-blobs");

    const read = await store.get(7, SHA);

    expect(Array.from(read!)).toEqual(Array.from(BYTES));
    expect(sendMock.mock.calls[0][0].input).toEqual({
      Bucket: "agentfactory-blobs",
      Key: `7/${SHA.slice(0, 2)}/${SHA}`,
    });
  });

  // Same contract as FsBlobStore's ENOENT branch: a missing object is undefined, not a throw.
  it("returns undefined when the object does not exist", async () => {
    sendMock.mockRejectedValue(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
    const store = new S3BlobStore("agentfactory-blobs");

    await expect(store.get(7, SHA)).resolves.toBeUndefined();
  });

  it("rethrows any other S3 error rather than swallowing it as a miss", async () => {
    sendMock.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const store = new S3BlobStore("agentfactory-blobs");

    await expect(store.get(7, SHA)).rejects.toThrow("denied");
  });

  it("keys two orgs' identical bytes separately", async () => {
    sendMock.mockResolvedValue({});
    const store = new S3BlobStore("agentfactory-blobs");

    await store.put(1, BYTES, "text/markdown");
    await store.put(2, BYTES, "text/markdown");

    expect(sendMock.mock.calls[0][0].input.Key).toBe(`1/${SHA.slice(0, 2)}/${SHA}`);
    expect(sendMock.mock.calls[1][0].input.Key).toBe(`2/${SHA.slice(0, 2)}/${SHA}`);
  });
});
