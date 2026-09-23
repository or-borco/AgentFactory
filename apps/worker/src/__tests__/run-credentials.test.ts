import { describe, expect, it } from "vitest";
import { MAX_RUN_CREDENTIAL_TTL_MS, RUN_CREDENTIAL_PREFIX, RunCredentialStore } from "../run-credentials";

function clockedStore() {
  let now = 1_000_000;
  const store = new RunCredentialStore(() => now);
  return { store, advance: (ms: number) => (now += ms) };
}

describe("RunCredentialStore", () => {
  it("issues distinct, unguessable tokens that resolve to their context", () => {
    const { store } = clockedStore();
    const a = store.issue({ orgId: 1, runId: 10, purpose: "run" });
    const b = store.issue({ orgId: 2, purpose: "repo-map" });

    expect(a).not.toBe(b);
    expect(a.startsWith(RUN_CREDENTIAL_PREFIX)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(RUN_CREDENTIAL_PREFIX.length + 43);
    expect(store.resolve(a)).toEqual({ orgId: 1, runId: 10, purpose: "run" });
    expect(store.resolve(b)).toEqual({ orgId: 2, purpose: "repo-map" });
  });

  it("stops resolving a token once it is revoked", () => {
    const { store } = clockedStore();
    const token = store.issue({ orgId: 1, purpose: "run" });

    store.revoke(token);

    expect(store.resolve(token)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("expires a token after its lifetime", () => {
    const { store, advance } = clockedStore();
    const token = store.issue({ orgId: 1, purpose: "run" }, 1000);

    advance(999);
    expect(store.resolve(token)).toBeDefined();
    advance(1);
    expect(store.resolve(token)).toBeUndefined();
  });

  it("never lets a token outlive the maximum lifetime", () => {
    const { store, advance } = clockedStore();
    const token = store.issue({ orgId: 1, purpose: "run" }, 10 * MAX_RUN_CREDENTIAL_TTL_MS);

    advance(MAX_RUN_CREDENTIAL_TTL_MS);

    expect(store.resolve(token)).toBeUndefined();
  });

  it("drops expired tokens from memory", () => {
    const { store, advance } = clockedStore();
    store.issue({ orgId: 1, purpose: "run" }, 1000);
    store.issue({ orgId: 1, purpose: "run" }, 5000);

    advance(2000);

    expect(store.size()).toBe(1);
  });

  it("resolves nothing for a missing or unknown token", () => {
    const { store } = clockedStore();
    expect(store.resolve(undefined)).toBeUndefined();
    expect(store.resolve("")).toBeUndefined();
    expect(store.resolve(`${RUN_CREDENTIAL_PREFIX}forged`)).toBeUndefined();
  });
});
