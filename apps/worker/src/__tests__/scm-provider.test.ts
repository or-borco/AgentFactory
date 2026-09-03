import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";

// signAppJwt() needs a real asymmetric key to actually sign with — irrelevant to what these
// tests check, so stub jsonwebtoken entirely.
vi.mock("jsonwebtoken", () => ({ default: { sign: vi.fn(() => "fake.app.jwt") } }));

const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
vi.mock("@agentfactory/db", () => ({ listConnections: (orgId: number) => listConnectionsMock(orgId) }));

const {
  buildPullRequestBody,
  cloneIntoSandbox,
  fetchCommitRangeDiff,
  fetchIssue,
  openDraftPullRequest,
  parseIssueReference,
  pushChangesIfDirty,
  resolveCloneTarget,
  resolveDefaultBranchSha,
} = await import("../scm-provider");

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
    resetMemory: vi.fn(),
  };
}

// Same as fakeSandbox, but keeps the argv it was called with so a test can assert on the
// shell script the caller actually built.
function capturingSandbox(chunks: OutputChunk[]): { sandbox: SandboxProvider; script: () => string } {
  let captured = "";
  return {
    sandbox: {
      create: vi.fn(),
      exec: async function* (_id: string, argv: string[]) {
        captured = argv[argv.length - 1];
        for (const chunk of chunks) yield chunk;
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    } as unknown as SandboxProvider,
    script: () => captured,
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

  // The exclude is what stops task documents (task-documents.ts) being swept into the user's PR
  // by pushChangesIfDirty's `git add -A`. Asserted on the script itself because there is no
  // container here to run it in; that the pattern actually works is proved separately, against
  // real git, in task-documents.test.ts.
  it("teaches git to ignore the task-document directory on a fresh clone", async () => {
    let captured: string[] = [];
    const exec = (_id: string, cmd: string[]) => {
      captured = cmd;
      return (async function* (): AsyncGenerator<OutputChunk> {
        yield { stream: "stdout", data: "CLONE_OK\n" };
      })();
    };
    const sandbox = { ...fakeSandbox([]), exec } as unknown as SandboxProvider;

    await cloneIntoSandbox(sandbox, "sandbox-1", target);

    const script = captured[2];
    expect(script).toContain(".git/info/exclude");
    expect(script).toContain("/.agentfactory/");
    expect(script).toContain("ensure_context_dir_excluded");
  });

  // A session's second run hits the ALREADY_CLONED path. A sandbox created before this shipped
  // would otherwise never get the exclude and would push a stray directory exactly once.
  it("applies the exclude on the already-cloned path too", async () => {
    let captured: string[] = [];
    const exec = (_id: string, cmd: string[]) => {
      captured = cmd;
      return (async function* (): AsyncGenerator<OutputChunk> {
        yield { stream: "stdout", data: "ALREADY_CLONED\n" };
      })();
    };
    const sandbox = { ...fakeSandbox([]), exec } as unknown as SandboxProvider;

    await cloneIntoSandbox(sandbox, "sandbox-1", target);

    const script = captured[2];
    expect(script).toMatch(/ALREADY_CLONED/);
    expect(script).toContain("ensure_context_dir_excluded; echo ALREADY_CLONED");
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
      resetMemory: vi.fn(),
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

  it("returns pushed:false and no changed files when the tree is clean", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([{ stream: "stdout", data: "NO_CHANGES\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: false,
      changedFiles: [],
    });
  });

  it("returns pushed:true when the commit and push succeed", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await expect(
      pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer"),
    ).resolves.toMatchObject({ pushed: true });
  });

  it("returns the paths committed in this turn, parsed out of the diff-tree marker lines", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([
      { stream: "stdout", data: "CHANGED_FILE:src/foo.ts\nCHANGED_FILE:README.md\n" },
      { stream: "stdout", data: "PUSH_OK\n" },
    ]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: true,
      changedFiles: ["src/foo.ts", "README.md"],
    });
  });

  it("reports the commit range this push added to the branch", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const base = "1".repeat(40);
    const head = "2".repeat(40);
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `BASE_SHA:${base}\nHEAD_SHA:${head}\n` },
      { stream: "stdout", data: "PUSH_OK\n" },
    ]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toMatchObject({
      pushed: true,
      commitRange: { baseSha: base, headSha: head },
    });
  });

  it("asks the sandbox for both ends of the range before and after committing", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const { sandbox, script } = capturingSandbox([{ stream: "stdout", data: "NO_CHANGES\n" }]);
    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    expect(script()).toContain("BASE_SHA:");
    expect(script()).toContain("HEAD_SHA:");
  });

  it("omits the commit range when the sandbox reported no shas", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    const result = await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    expect(result.pushed).toBe(true);
    expect(result.commitRange).toBeUndefined();
  });

  it("omits the commit range when nothing was pushed", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `BASE_SHA:${"3".repeat(40)}\n` },
      { stream: "stdout", data: "NO_CHANGES\n" },
    ]);
    const result = await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    expect(result.pushed).toBe(false);
    expect(result.commitRange).toBeUndefined();
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

  it("reports a recovered branch mismatch when the agent committed on a descendant branch that got fast-forwarded", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([{ stream: "stdout", data: "BRANCH_MISMATCH:fix/53-surface-real-run-error\nPUSH_OK\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: true,
      changedFiles: [],
      branchMismatch: { agentBranch: "fix/53-surface-real-run-error" },
    });
  });

  it("reports an unrecovered branch mismatch when the agent's branch wasn't a descendant of the session branch", async () => {
    vi.stubGlobal("fetch", mockTokenMint());
    const sandbox = fakeSandbox([{ stream: "stdout", data: "BRANCH_MISMATCH:main\nNO_CHANGES\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: false,
      changedFiles: [],
      branchMismatch: { agentBranch: "main" },
    });
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
      resetMemory: vi.fn(),
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

describe("parseIssueReference", () => {
  it("extracts the repo and issue number from a github issue url", () => {
    expect(parseIssueReference("https://github.com/acme-org/platform/issues/37")).toEqual({
      repoFullName: "acme-org/platform",
      issueNumber: 37,
    });
  });

  it("finds the link even when it's embedded in surrounding text", () => {
    expect(parseIssueReference("Please review https://github.com/acme-org/platform/issues/8 today")).toEqual({
      repoFullName: "acme-org/platform",
      issueNumber: 8,
    });
  });

  it("returns undefined when there's no issue link", () => {
    expect(parseIssueReference("Add a retry button to the failed-run banner.")).toBeUndefined();
  });

  it("returns undefined for a pull request link", () => {
    expect(parseIssueReference("https://github.com/acme-org/platform/pull/37")).toBeUndefined();
  });
});

describe("fetchIssue", () => {
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

  it("fetches the issue's title and body via the org's installation that has the repo", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repositories: [{ full_name: "acme-org/platform" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_issue" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ title: "Crash on startup", body: "Steps to reproduce..." }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const issue = await fetchIssue(1, "acme-org/platform", 37);

    expect(issue).toEqual({ title: "Crash on startup", body: "Steps to reproduce..." });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.github.com/repos/acme-org/platform/issues/37",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghs_issue" }) }),
    );
  });

  it("returns undefined when no connection in the org has access to the repo", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ repositories: [{ full_name: "other-org/other-repo" }] }), { status: 200 }),
        ),
    );

    await expect(fetchIssue(1, "acme-org/platform", 37)).resolves.toBeUndefined();
  });

  it("never sees org B's repo when called with org A's id, even if org B's installation has it", async () => {
    // org 1 (the caller) only has an installation covering "other-org/other-repo"; the repo
    // requested belongs to org 2's installation and must stay invisible to org 1's lookup.
    listConnectionsMock.mockImplementation(async (orgId: number) =>
      orgId === 1 ? [githubConnection(1, 111)] : [githubConnection(2, 222)],
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ repositories: [{ full_name: "other-org/other-repo" }] }), { status: 200 }),
        ),
    );

    await expect(fetchIssue(1, "acme-org/platform", 37)).resolves.toBeUndefined();
  });

  it("throws when the issue lookup fails", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ repositories: [{ full_name: "acme-org/platform" }] }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_issue" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("not found", { status: 404 })),
    );

    await expect(fetchIssue(1, "acme-org/platform", 37)).rejects.toThrow("GitHub API issue fetch failed: 404");
  });
});

describe("resolveDefaultBranchSha", () => {
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

  it("returns the default branch's HEAD sha for a repo the org can access", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ repositories: [{ full_name: "acme-org/platform" }] }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_api" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "abc123" }), { status: 200 })),
    );

    await expect(resolveDefaultBranchSha(1, "acme-org/platform")).resolves.toBe("abc123");
  });

  it("returns undefined when no installation can see the repo", async () => {
    listConnectionsMock.mockResolvedValue([githubConnection(1, 999)]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ repositories: [] }), { status: 200 })),
    );

    await expect(resolveDefaultBranchSha(1, "acme-org/platform")).resolves.toBeUndefined();
  });
});

describe("fetchCommitRangeDiff", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  const target = {
    cloneUrl: "https://x-access-token:ghs@github.com/acme-org/platform.git",
    branch: "agent/session-12",
    repoFullName: "acme-org/platform",
    installationId: 999,
  };
  const RANGE = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };

  function tokenResponse() {
    return new Response(JSON.stringify({ token: "ghs_diff" }), { status: 200 });
  }

  it("compares the two shas directly and returns the diff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("diff --git a/x b/x\n+added\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCommitRangeDiff(target, RANGE)).resolves.toBe("diff --git a/x b/x\n+added\n");

    // Shas, not the branch name: the branch has moved on if a later run pushed to it. They are
    // hex, so no encoding question arises — the pitfall that made the branch-based compare
    // unsafe cannot recur here.
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/acme-org/platform/compare/${RANGE.baseSha}...${RANGE.headSha}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghs_diff",
          Accept: "application/vnd.github.v3.diff",
        }),
      }),
    );
  });

  it("returns an empty diff as a string, never undefined — no result can read as a never-committed signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response("", { status: 200 })),
    );
    // "" and not undefined: the caller decides whether a run committed from its recorded commit
    // range, and nothing this function returns may be mistaken for that answer.
    await expect(fetchCommitRangeDiff(target, RANGE)).resolves.toBe("");
  });

  it("raises on a 404 — a recorded range whose commits are gone is unavailable, never never-committed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response("Not Found", { status: 404 })),
    );
    await expect(fetchCommitRangeDiff(target, RANGE)).rejects.toThrow(/compare failed: 404/);
  });

  it("raises on any other error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(new Response("boom", { status: 500 })),
    );
    await expect(fetchCommitRangeDiff(target, RANGE)).rejects.toThrow(/compare failed: 500/);
  });
});

describe("buildPullRequestBody", () => {
  it("includes the task reference, the agent's summary, the task description, and the changed files", () => {
    const body = buildPullRequestBody({
      taskRef: "T-042",
      taskDescription: "Add a retry button to the failed-run banner.",
      summary: "Added a Retry button that re-enqueues the run.",
      changedFiles: ["src/RunBanner.tsx", "src/api.ts"],
    });

    expect(body).toContain("Opened automatically by AgentFactory for task T-042.");
    expect(body).toContain("Added a Retry button that re-enqueues the run.");
    expect(body).toContain("Add a retry button to the failed-run banner.");
    expect(body).toContain("- `src/RunBanner.tsx`");
    expect(body).toContain("- `src/api.ts`");
  });

  it("omits empty sections instead of leaving blank headings", () => {
    const body = buildPullRequestBody({ taskRef: "T-1", taskDescription: "", summary: "", changedFiles: [] });

    expect(body).toBe("Opened automatically by AgentFactory for task T-1.");
  });

  it("strips the sandbox's /workspace mount path out of the agent's summary", () => {
    const body = buildPullRequestBody({
      taskRef: "T-057",
      taskDescription: "",
      summary: "Created `/workspace/README.md` with a full local-setup guide. Files live under /workspace.",
      changedFiles: [],
    });

    expect(body).toContain("Created `README.md` with a full local-setup guide.");
    expect(body).toContain("Files live under the repo root.");
    expect(body).not.toContain("/workspace");
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
