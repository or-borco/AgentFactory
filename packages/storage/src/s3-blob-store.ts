import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type BlobStore, sha256Hex } from "./blob-store";

// The deployed-environment adapter. Same key layout as FsBlobStore — <orgId>/<sha[0:2]>/<sha> —
// so the two are interchangeable over one key space and a dev-to-prod move is a config change,
// not a migration. Credentials come from the ambient provider chain (instance role, env vars,
// shared config); nothing about them is this class's business.
export class S3BlobStore implements BlobStore {
  private readonly client = new S3Client({});

  constructor(private readonly bucket: string) {}

  async put(
    orgId: number,
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ sha256: string; sizeBytes: number }> {
    const sha256 = sha256Hex(bytes);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: keyFor(orgId, sha256),
        Body: bytes,
        ContentType: mime,
      }),
    );
    return { sha256, sizeBytes: bytes.byteLength };
  }

  async get(orgId: number, sha256: string): Promise<Uint8Array | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: keyFor(orgId, sha256) }),
      );
      if (!response.Body) return undefined;
      return await response.Body.transformToByteArray();
    } catch (err) {
      // Only a genuine miss becomes undefined. AccessDenied and friends must surface — swallowing
      // them would look identical to "the team uploaded nothing", which is exactly the failure the
      // retrieval layer is designed to degrade quietly on.
      if ((err as { name?: string }).name === "NoSuchKey") return undefined;
      throw err;
    }
  }
}

function keyFor(orgId: number, sha256: string): string {
  return `${orgId}/${sha256.slice(0, 2)}/${sha256}`;
}
