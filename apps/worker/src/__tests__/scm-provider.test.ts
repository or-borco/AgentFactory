import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";

// signAppJwt() needs a real asymmetric key to actually sign with — irrelevant to what these
// tests check, so stub jsonwebtoken entirely.
vi.mock("jsonwebtoken", () => ({ default: { sign: vi.fn(() => "fake.app.jwt") } }));

const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
vi.mock("@agentfactory/db", () => ({ listConnections: (orgId: number) => listConnectionsMock(orgId) }));

const { cloneIntoSandbox, openDraftPullRequest, pushChangesIfDirty, resolveCloneTarget } =
  await import("../scm-provider");

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
      installationId: 999,
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

  it("throws immediately when the app itself isn't configured, instead of reporting a misleading 'repo not accessible'", async () => {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveCloneTarget(1, "acme-org/platform", "agent/session-42")).rejects.toThrow(
      "GITHUB_APP_PRIVATE_KEY is not set",
    );
    // Never even tried to look anything up on GitHub — this is a config problem, not a per-repo one.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cloneIntoSandbox", () => {
  const target = {
    cloneUrl: "https://x-access-token:ghs@github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
    installationId: 999,
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

describe("pushChangesIfDirty", () => {
  const target = {
    cloneUrl: "https://x-access-token:ghs_clone@github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
    installationId: 999,
  };

  beforeEach(() => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  function mockTokenMint() {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "ghs_push" }), { status: 200 }));
  }

  it("returns false and pushes nothing when the tree is clean", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([{ stream: "stdout", data: "NO_CHANGES\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toBe(false);
  });

  it("returns true when the commit and push succeed", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toBe(true);
  });

  it("throws when the push fails", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([
      { stream: "stderr", data: "! [rejected]\n" },
      { stream: "stdout", data: "PUSH_FAILED\n" },
    ]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).rejects.toThrow(
      "Failed to push agent changes to the remote",
    );
  });

  it("mints its own fresh token rather than reusing anything from the clone step", async () => {
    const fetchMock = mockTokenMint();
    vi.stubGlobal("fetch", fetchMock);
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);

    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/999/access_tokens",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("passes the token, repo, branch, commit message, and author as env vars, not argv — the token never appears in the command itself", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    let capturedEnv: Record<string, string> | undefined;
    let capturedCmd: string[] | undefined;
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: async function* (_id, cmd, opts) {
        capturedCmd = cmd;
        capturedEnv = opts?.env;
        yield { stream: "stdout", data: "PUSH_OK\n" };
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
    };

    await pushChangesIfDirty(sandbox, "sandbox-1", target, "Fix the bug", "Code reviewer");

    expect(capturedEnv).toEqual({
      BRANCH_NAME: "agent/session-1",
      REPO_FULL_NAME: "acme-org/platform",
      COMMIT_MESSAGE: "Fix the bug",
      AUTHOR_NAME: "Code reviewer",
      PUSH_TOKEN: "ghs_push",
    });
    expect(capturedCmd?.join(" ")).not.toContain("ghs_push");
  });
});

describe("openDraftPullRequest", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("fetches the repo's default branch and opens a draft PR against it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_pr" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "develop" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ number: 7, html_url: "https://github.com/acme-org/platform/pull/7" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pr = await openDraftPullRequest(999, "acme-org/platform", "agent/session-1", "Fix the bug", "body text");

    expect(pr).toEqual({ number: 7, url: "https://github.com/acme-org/platform/pull/7" });
    const [, , prCall] = fetchMock.mock.calls;
    expect(prCall[0]).toBe("https://api.github.com/repos/acme-org/platform/pulls");
    expect(JSON.parse(prCall[1].body)).toEqual({
      title: "Fix the bug",
      head: "agent/session-1",
      base: "develop",
      body: "body text",
      draft: true,
    });
  });

  it("throws when the repo lookup fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_pr" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openDraftPullRequest(999, "acme-org/platform", "agent/session-1", "title", "body"),
    ).rejects.toThrow("GitHub API repo lookup failed: 404");
  });

  it("throws when PR creation fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_pr" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("unprocessable", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      openDraftPullRequest(999, "acme-org/platform", "agent/session-1", "title", "body"),
    ).rejects.toThrow("GitHub API PR creation failed: 422");
  });
});
