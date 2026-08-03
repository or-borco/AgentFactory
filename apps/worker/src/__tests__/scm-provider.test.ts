import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";

// signAppJwt() needs a real asymmetric key to actually sign with — irrelevant to what these
// tests check, so stub jsonwebtoken entirely.
vi.mock("jsonwebtoken", () => ({ default: { sign: vi.fn(() => "fake.app.jwt") } }));

const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
vi.mock("@agentfactory/db", () => ({ listConnections: (orgId: number) => listConnectionsMock(orgId) }));

const { cloneIntoSandbox, resolveCloneTarget } = await import("../scm-provider");

function githubConnection(id: number, installationId: number): Connection {
  return {
    id,
    orgId: 1,
    provider: "github",
    kind: "scm",
    label: `installation-${installationId}`,
    health: "healthy",
    config: { installationId },
    createdAt: new Date().toISOString(),
  };
}

describe("resolveCloneTarget", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    listConnectionsMock.mockReset();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  function mockTokenAndRepos(repoNames: string[]) {
    return vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repositories: repoNames.map((full_name) => ({ full_name })) }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_clone" }), { status: 200 }));
  }

  it("returns a clone URL embedding a fresh token for the installation that has the repo", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    vi.stubGlobal("fetch", mockTokenAndRepos(["acme-org/platform"]));

    const target = await resolveCloneTarget(1, "acme-org/platform", "agent/session-42");

    expect(target).toEqual({
      cloneUrl: "https://x-access-token:ghs_clone@github.com/acme-org/platform.git",
      branch: "agent/session-42",
      repoFullName: "acme-org/platform",
    });
  });

  it("skips connections whose repo list doesn't include the target repo", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    vi.stubGlobal("fetch", mockTokenAndRepos(["acme-org/other-repo"]));

    await expect(resolveCloneTarget(1, "acme-org/platform", "agent/session-42")).resolves.toBeUndefined();
  });

  it("returns undefined when the org has no github connections", async () => {
    listConnectionsMock.mockResolvedValue([]);
    await expect(resolveCloneTarget(1, "acme-org/platform", "agent/session-42")).resolves.toBeUndefined();
  });

  it("skips a connection whose installation lookup fails and keeps checking others", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 111), githubConnection(2, 222)]);
    const fetchMock = vi
      .fn()
      // installation 111: token mint fails outright
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      // installation 222: succeeds
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repositories: [{ full_name: "acme-org/platform" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_clone" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const target = await resolveCloneTarget(1, "acme-org/platform", "agent/session-42");
    expect(target?.cloneUrl).toBe("https://x-access-token:ghs_clone@github.com/acme-org/platform.git");
  });
});

describe("cloneIntoSandbox", () => {
  function fakeSandbox(chunks: OutputChunk[]): SandboxProvider {
    return {
      create: vi.fn(),
      exec: async function* () {
        for (const chunk of chunks) yield chunk;
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
    };
  }

  const target = {
    cloneUrl: "https://x-access-token:ghs@github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
  };

  it("resolves when the clone succeeds", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "CLONE_OK\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).resolves.toBeUndefined();
  });

  it("resolves without re-cloning when the workspace already has the same repo", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "ALREADY_CLONED\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).resolves.toBeUndefined();
  });

  it("throws a clear error when the workspace already has a different repo cloned", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "REPO_MISMATCH\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).rejects.toThrow(
      'Sandbox workspace already contains a different repository than "acme-org/platform"',
    );
  });

  it("throws when the clone fails", async () => {
    const sandbox = fakeSandbox([
      { stream: "stderr", data: "fatal: could not read Username\n" },
      { stream: "stdout", data: "CLONE_FAILED\n" },
    ]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).rejects.toThrow(
      "Failed to clone repository into sandbox workspace",
    );
  });

  it("passes the clone url, branch, and target repo as env vars, not argv", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: async function* (_id, _cmd, opts) {
        capturedEnv = opts?.env;
        yield { stream: "stdout", data: "CLONE_OK\n" };
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
    };

    await cloneIntoSandbox(sandbox, "sandbox-1", target);

    expect(capturedEnv).toEqual({
      CLONE_URL: target.cloneUrl,
      BRANCH_NAME: target.branch,
      REPO_FULL_NAME: target.repoFullName,
    });
  });
});
