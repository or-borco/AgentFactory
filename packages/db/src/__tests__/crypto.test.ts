import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

// No database involved — this file lives directly under __tests__/ (not __tests__/repositories/)
// so vitest.config.ts's `unit` project picks it up and `db-integration` does not.

// crypto.ts reads CONNECTION_SECRET_KEY inside the function body, not at module scope (matching
// packages/storage/src/index.ts's createBlobStore() pattern), so a plain top-level import here is
// safe even for the "env var missing" test below — nothing throws until encryptSecret/decryptSecret
// is actually called.
import { decryptSecret, encryptSecret } from "../crypto";

const VALID_KEY = randomBytes(32).toString("base64");

describe("crypto", () => {
  const originalKey = process.env.CONNECTION_SECRET_KEY;

  beforeEach(() => {
    process.env.CONNECTION_SECRET_KEY = VALID_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.CONNECTION_SECRET_KEY;
    } else {
      process.env.CONNECTION_SECRET_KEY = originalKey;
    }
  });

  it("round-trips a plaintext record through encrypt and decrypt", () => {
    const plaintext = { apiToken: "secret-token-value", accountEmail: "user@example.com" };

    const ciphertext = encryptSecret(plaintext);
    const decrypted = decryptSecret(ciphertext);

    expect(decrypted).toEqual(plaintext);
  });

  it("produces different ciphertexts for identical plaintext (random IV)", () => {
    const plaintext = { apiToken: "same-value" };

    const first = encryptSecret(plaintext);
    const second = encryptSecret(plaintext);

    expect(first).not.toBe(second);
    // Both must still decrypt to the same value — the difference is only the IV, not correctness.
    expect(decryptSecret(first)).toEqual(plaintext);
    expect(decryptSecret(second)).toEqual(plaintext);
  });

  it("throws when a ciphertext byte is tampered with (GCM auth tag rejects it)", () => {
    const ciphertext = encryptSecret({ apiToken: "tamper-me" });
    const buf = Buffer.from(ciphertext, "base64");
    // Flip one byte roughly in the middle of the envelope — lands inside the auth tag or the
    // payload for any reasonably sized plaintext, either of which must fail GCM verification.
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    const tampered = buf.toString("base64");

    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws an error naming the env var when CONNECTION_SECRET_KEY is missing", () => {
    delete process.env.CONNECTION_SECRET_KEY;

    expect(() => encryptSecret({ apiToken: "x" })).toThrow(/CONNECTION_SECRET_KEY/);
  });

  it("throws a specific error when the decoded key is not 32 bytes", () => {
    process.env.CONNECTION_SECRET_KEY = Buffer.from("too-short").toString("base64");

    expect(() => encryptSecret({ apiToken: "x" })).toThrow(/32 bytes/);
  });
});
