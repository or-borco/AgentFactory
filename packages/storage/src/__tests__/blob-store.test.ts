import { describe, expect, it } from "vitest";
import { sha256Hex } from "../blob-store";

// Standard SHA-256 test vectors. Hard-coded rather than computed in the test, so a change in how
// bytes are fed to the hash is a failure here and not a silently different key space.
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("hashes the empty input to the known digest", () => {
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY);
  });

  it("hashes 'abc' to the known digest", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(ABC);
  });

  it("is deterministic across separately constructed but equal inputs", () => {
    const encoder = new TextEncoder();
    expect(sha256Hex(encoder.encode("# Handbook\n\nUse pnpm.\n"))).toBe(
      sha256Hex(encoder.encode("# Handbook\n\nUse pnpm.\n")),
    );
  });

  it("returns 64 lowercase hex characters", () => {
    expect(sha256Hex(new TextEncoder().encode("anything"))).toMatch(/^[0-9a-f]{64}$/);
  });

  // Buffer is a Uint8Array subclass and is what node:fs hands back; a hash fed the wrong view of a
  // pooled Buffer's ArrayBuffer would silently key content under the wrong sha.
  it("agrees on a Node Buffer and a plain Uint8Array holding the same bytes", () => {
    const bytes = new TextEncoder().encode("abc");
    expect(sha256Hex(Buffer.from(bytes))).toBe(ABC);
    expect(sha256Hex(bytes)).toBe(ABC);
  });
});
