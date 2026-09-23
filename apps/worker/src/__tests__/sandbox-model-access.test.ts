import { afterEach, describe, expect, it, vi } from "vitest";
import { RunCredentialStore, type ModelProvider } from "../run-credentials";
import { issueSandboxModelCredential, resolveCredentials } from "../sandbox-model-access";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("issueSandboxModelCredential", () => {
  it("points the sandbox at the proxy route for the credential's provider", () => {
    const store = new RunCredentialStore();

    const credential = issueSandboxModelCredential({ orgId: 3, runId: 9, purpose: "run", provider: "anthropic" }, store);

    expect(credential.endpoint.baseUrl).toBe("http://host.docker.internal:8787/anthropic");
    expect(store.resolve(credential.endpoint.token)).toEqual({ orgId: 3, runId: 9, purpose: "run", provider: "anthropic" });
  });

  it("stops the token working once revoked", () => {
    const store = new RunCredentialStore();
    const credential = issueSandboxModelCredential({ orgId: 3, purpose: "repo-map", provider: "anthropic" }, store);

    credential.revoke();

    expect(store.resolve(credential.endpoint.token)).toBeUndefined();
  });
});

describe("resolveCredentials", () => {
  it("returns the platform key for a known provider", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-platform");
    expect(resolveCredentials(3, "anthropic")).toBe("sk-platform");
  });

  it("returns nothing for a provider with no configured key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-platform");
    expect(resolveCredentials(3, "stubai" as ModelProvider)).toBeUndefined();
  });

  it("returns nothing when the platform key is unset", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(resolveCredentials(3, "anthropic")).toBeUndefined();
  });
});
