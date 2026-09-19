import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM helpers, shared by connection_secrets.ciphertext and agent_memory_entries.ciphertext
// (packages/db/src/repositories/agent-memory.ts). Envelope format is
// base64(iv[12] || authTag[16] || ciphertext). This is defense against a database dump, not a
// KMS: the key is a single app-level secret read from CONNECTION_SECRET_KEY.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;

// Bump this — and add a re-encrypt migration — the day CONNECTION_SECRET_KEY rotates. Exported so
// the connection-secrets repository (a later PR) can stamp connection_secrets.keyVersion on insert
// without duplicating this magic number.
export const CURRENT_KEY_VERSION = 1;

// Read (and validate) the key inside the function body, never at module scope — the same rule
// packages/storage/src/index.ts's createBlobStore() documents: a module-body read would freeze
// the value (or throw) at import time, which breaks `tsx watch` (re-imports on every save) and the
// pre-push hook (runs the unit suite with no guarantee CONNECTION_SECRET_KEY is set).
function getKey(): Buffer {
  const raw = process.env.CONNECTION_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "CONNECTION_SECRET_KEY is not set. Generate one with `openssl rand -base64 32` and set it " +
        "in your .env.local.",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `CONNECTION_SECRET_KEY must decode to ${KEY_LENGTH_BYTES} bytes (got ${key.length}) — ` +
        "generate one with `openssl rand -base64 32`.",
    );
  }

  return key;
}

/** Encrypts a plaintext credential record. The record is JSON-stringified before encryption. */
export function encryptSecret(plaintext: Record<string, string>): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypts an envelope produced by encryptSecret back into its plaintext record. Throws if the
 * key is wrong or the ciphertext has been tampered with — GCM's auth tag makes this a hard
 * failure rather than a garbled result.
 */
export function decryptSecret(ciphertext: string): Record<string, string> {
  const key = getKey();
  const envelope = Buffer.from(ciphertext, "base64");

  const iv = envelope.subarray(0, IV_LENGTH_BYTES);
  const authTag = envelope.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const encrypted = envelope.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as Record<string, string>;
}
