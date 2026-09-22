import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";
import { SKILL_EXCLUDE_PATTERN } from "../skill-paths";

const resolveScmConnectionMock = vi.fn();
const getScmProviderMock = vi.fn();
const parseIssueReferenceAcrossProvidersMock = vi.fn();
vi.mock("@agentfactory/scm", () => ({
  resolveScmConnection: (orgId: number, repoFullName: string) => resolveScmConnectionMock(orgId, repoFullName),
  getScmProvider: (id: string) => getScmProviderMock(id),
  parseIssueReferenceAcrossProviders: (text: string) => parseIssueReferenceAcrossProvidersMock(text),
}));

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
  sessionBranchName,
  syncWithDefaultBranch,
} = await import("../scm-provider");

function fakeConnection(id: number): Connection {
  return {
    id,
    orgId: 1,
    provider: "github",
    kind: "scm",
    label: "installation-1",
    health: "healthy",
    config: {},
    auth: "none",
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
    interrupt: vi.fn(),
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
      interrupt: vi.fn(),
    } as unknown as SandboxProvider,
    script: () => captured,
  };
}

afterEach(() => {
  resolveScmConnectionMock.mockReset();
  getScmProviderMock.mockReset();
  parseIssueReferenceAcrossProvidersMock.mockReset();
});

describe("resolveCloneTarget (thin wrapper over the registry)", () => {
  it("delegates to the resolved provider's resolveCloneTarget", async () => {
    const connection = fakeConnection(1);
    const providerResolveCloneTarget = vi.fn().mockResolvedValue({ repoFullName: "acme/widgets" });
    resolveScmConnectionMock.mockResolvedValue({ connection, provider: { resolveCloneTarget: providerResolveCloneTarget } });

    const result = await resolveCloneTarget(1, "acme/widgets", "agent/session-1");

    expect(resolveScmConnectionMock).toHaveBeenCalledWith(1, "acme/widgets");
    expect(providerResolveCloneTarget).toHaveBeenCalledWith(connection, "acme/widgets", "agent/session-1");
    expect(result).toEqual({ repoFullName: "acme/widgets" });
  });

  it("returns undefined when no connection resolves", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    await expect(resolveCloneTarget(1, "acme/widgets", "b")).resolves.toBeUndefined();
  });
});

describe("fetchIssue (thin wrapper over the registry)", () => {
  it("delegates to the resolved provider's fetchIssue", async () => {
    const connection = fakeConnection(1);
    const providerFetchIssue = vi.fn().mockResolvedValue({ title: "T", body: "B" });
    resolveScmConnectionMock.mockResolvedValue({ connection, provider: { fetchIssue: providerFetchIssue } });

    await expect(fetchIssue(1, "acme/widgets", 37)).resolves.toEqual({ title: "T", body: "B" });
    expect(providerFetchIssue).toHaveBeenCalledWith(connection, "acme/widgets", 37);
  });

  it("returns undefined when no connection resolves", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    await expect(fetchIssue(1, "acme/widgets", 37)).resolves.toBeUndefined();
  });
});

describe("resolveDefaultBranchSha (thin wrapper over the registry)", () => {
  it("delegates to the resolved provider's resolveDefaultBranchSha", async () => {
    const connection = fakeConnection(1);
    const providerFn = vi.fn().mockResolvedValue("abc123");
    resolveScmConnectionMock.mockResolvedValue({ connection, provider: { resolveDefaultBranchSha: providerFn } });

    await expect(resolveDefaultBranchSha(1, "acme/widgets")).resolves.toBe("abc123");
    expect(providerFn).toHaveBeenCalledWith(connection, "acme/widgets");
  });

  it("returns undefined when no connection resolves", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    await expect(resolveDefaultBranchSha(1, "acme/widgets")).resolves.toBeUndefined();
  });
});

describe("fetchCommitRangeDiff (thin wrapper over the registry)", () => {
  const target = { cloneUrl: "x", remoteUrl: "y", branch: "b", repoFullName: "acme/widgets", provider: "github" as const, installationRef: 1 };
  const range = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };

  it("delegates to the target's own provider", async () => {
    const providerFn = vi.fn().mockResolvedValue("diff text");
    getScmProviderMock.mockReturnValue({ fetchCommitRangeDiff: providerFn });

    await expect(fetchCommitRangeDiff(target, range)).resolves.toBe("diff text");
    expect(getScmProviderMock).toHaveBeenCalledWith("github");
    expect(providerFn).toHaveBeenCalledWith(target, range);
  });

  it("throws when the target's provider isn't registered", async () => {
    getScmProviderMock.mockReturnValue(undefined);
    await expect(fetchCommitRangeDiff(target, range)).rejects.toThrow('No registered SCM provider for "github"');
  });
});

describe("openDraftPullRequest (thin wrapper over the registry)", () => {
  it("delegates to the resolved provider's openDraftPullRequest", async () => {
    const connection = fakeConnection(1);
    const providerFn = vi.fn().mockResolvedValue({ number: 7, url: "https://example.com/pull/7" });
    resolveScmConnectionMock.mockResolvedValue({ connection, provider: { openDraftPullRequest: providerFn } });

    const pr = await openDraftPullRequest(1, "acme/widgets", "agent/session-1", "title", "body");

    expect(pr).toEqual({ number: 7, url: "https://example.com/pull/7" });
    expect(providerFn).toHaveBeenCalledWith(connection, "acme/widgets", "agent/session-1", "title", "body");
  });

  it("throws when no connection resolves", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    await expect(openDraftPullRequest(1, "acme/widgets", "b", "t", "body")).rejects.toThrow(
      'No connected SCM provider can access repo "acme/widgets"',
    );
  });
});

describe("parseIssueReference (thin wrapper over the registry)", () => {
  it("delegates to parseIssueReferenceAcrossProviders", () => {
    parseIssueReferenceAcrossProvidersMock.mockReturnValue({ repoFullName: "a/b", issueNumber: 3, provider: "github" });
    expect(parseIssueReference("some text")).toEqual({ repoFullName: "a/b", issueNumber: 3, provider: "github" });
    expect(parseIssueReferenceAcrossProvidersMock).toHaveBeenCalledWith("some text");
  });
});

describe("cloneIntoSandbox", () => {
  const target = {
    cloneUrl: "https://x-access-token:ghs@github.com/acme-org/platform.git",
    remoteUrl: "https://github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
    provider: "github" as const,
    installationRef: 999,
  };

  it("resolves when the clone succeeds", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "CLONE_OK\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).resolves.toBeUndefined();
  });

  it("resolves without re-cloning when the workspace already has the same remote", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "ALREADY_CLONED\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).resolves.toBeUndefined();
  });

  it("throws a clear error when the workspace already has a different repo cloned", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "REPO_MISMATCH\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).rejects.toThrow(
      'Sandbox workspace already contains a different repository than "acme-org/platform"',
    );
  });

  it("compares the current remote against target.remoteUrl, not a hardcoded host", async () => {
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
    expect(script).toContain('"$REMOTE_URL") ensure_context_dir_excluded; echo ALREADY_CLONED');
    expect(script).not.toContain("github.com/$REPO_FULL_NAME");
  });

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

  it("also teaches git to ignore the materialised-skills directory", async () => {
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
    expect(script).toContain(SKILL_EXCLUDE_PATTERN);
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

  it("passes the clone url, remote url, and branch as env vars, not argv", async () => {
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
      interrupt: vi.fn(),
    };

    await cloneIntoSandbox(sandbox, "sandbox-1", target);

    expect(capturedEnv).toEqual({
      CLONE_URL: target.cloneUrl,
      REMOTE_URL: target.remoteUrl,
      BRANCH_NAME: target.branch,
    });
  });
});

describe("syncWithDefaultBranch", () => {
  const target = {
    cloneUrl: "https://x-access-token:ghs@github.com/acme-org/platform.git",
    remoteUrl: "https://github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
    provider: "github" as const,
    installationRef: 999,
  };

  it("reports up_to_date when nothing changed upstream", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "SYNC_UP_TO_DATE\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({ status: "up_to_date" });
  });

  it("reports synced with the number of commits merged", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "SYNC_OK:3\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({
      status: "synced",
      commitsMerged: 3,
    });
  });

  it("reports skipped_dirty without attempting a merge", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "SYNC_SKIPPED_DIRTY\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({ status: "skipped_dirty" });
  });

  it("reports skipped_conflict with the conflicting file paths", async () => {
    const sandbox = fakeSandbox([
      {
        stream: "stdout",
        data: "SYNC_CONFLICT_FILE:packages/db/src/schema.ts\nSYNC_CONFLICT_FILE:packages/core/src/domain.ts\nSYNC_SKIPPED_CONFLICT\n",
      },
    ]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({
      status: "skipped_conflict",
      conflictingFiles: ["packages/db/src/schema.ts", "packages/core/src/domain.ts"],
    });
  });

  it("fails soft to skipped_fetch_failed when the fetch itself fails", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "SYNC_SKIPPED_FETCH_FAILED\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({ status: "skipped_fetch_failed" });
  });

  it("fails soft to skipped_fetch_failed on unrecognized output, rather than throwing", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({ status: "skipped_fetch_failed" });
  });

  it("passes the clone url and remote url as env vars, not a hardcoded host", async () => {
    let capturedEnv: Record<string, string> | undefined;
    let capturedScript = "";
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: async function* (_id, cmd, opts) {
        capturedEnv = opts?.env;
        capturedScript = cmd[cmd.length - 1];
        yield { stream: "stdout", data: "SYNC_UP_TO_DATE\n" };
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
      interrupt: vi.fn(),
    };

    await syncWithDefaultBranch(sandbox, "sandbox-1", target);

    expect(capturedEnv).toEqual({ CLONE_URL: target.cloneUrl, REMOTE_URL: target.remoteUrl });
    expect(capturedScript).toContain('git remote set-url origin "$REMOTE_URL"');
    expect(capturedScript).not.toContain("github.com/$REPO_FULL_NAME");
  });
});

describe("sessionBranchName", () => {
  const task = { ref: "T-051", title: "Missalignment in the Activity section" };

  it("builds a human-readable name from the task ref and title, suffixed with the branchToken", () => {
    expect(sessionBranchName({ id: 9, branchToken: "a1b2c3d4" }, task)).toBe(
      "agent/t-051-missalignment-in-the-activity-section-a1b2c3d4",
    );
  });

  it("falls back to the bare id-only name for a session with no branchToken", () => {
    // Sessions created before the branchToken column existed have none — the branch they
    // already pushed under is the id-only name, so that's what a later run on the same session
    // has to keep using, regardless of what the task looks like now.
    expect(sessionBranchName({ id: 9 }, task)).toBe("agent/session-9");
  });

  it("drops the slug rather than leaving a trailing dash when the title has no alphanumerics", () => {
    expect(sessionBranchName({ id: 9, branchToken: "a1b2c3d4" }, { ref: "T-051", title: "🎉🎉🎉" })).toBe(
      "agent/t-051-a1b2c3d4",
    );
  });

  it("truncates a long title instead of letting the branch name run away", () => {
    const longTitle = "a".repeat(200);
    const name = sessionBranchName({ id: 9, branchToken: "a1b2c3d4" }, { ref: "T-051", title: longTitle });
    expect(name).toBe(`agent/t-051-${"a".repeat(40)}-a1b2c3d4`);
  });
});

describe("pushChangesIfDirty", () => {
  const target = {
    cloneUrl: "https://x-access-token:ghs_clone@github.com/acme-org/platform.git",
    remoteUrl: "https://github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
    provider: "github" as const,
    installationRef: 999,
  };

  function mockProvider(token = "ghs_push") {
    const mintPushToken = vi.fn().mockResolvedValue(token);
    getScmProviderMock.mockReturnValue({ mintPushToken });
    return mintPushToken;
  }

  it("returns pushed:false and no changed files when the tree is clean", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "NO_CHANGES\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: false,
      changedFiles: [],
    });
  });

  it("returns pushed:true when the commit and push succeed", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toMatchObject({
      pushed: true,
    });
  });

  it("returns the paths committed in this turn, parsed out of the diff-tree marker lines", async () => {
    mockProvider();
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
    mockProvider();
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

  it("re-fetches and merges the branch's remote tip before pushing, so a stale cached ref can't reject the push", async () => {
    mockProvider();
    const { sandbox, script } = capturingSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    const s = script();
    expect(s).toContain('git fetch origin "$BRANCH_NAME"');
    expect(s).toContain('git merge-base --is-ancestor "origin/$BRANCH_NAME" HEAD');
    expect(s).toContain('git merge --no-edit "origin/$BRANCH_NAME"');
    expect(s.indexOf('git fetch origin "$BRANCH_NAME"')).toBeLessThan(s.indexOf("git push --no-verify"));
  });

  it("aborts cleanly when merging in the remote tip conflicts", async () => {
    mockProvider();
    const { sandbox, script } = capturingSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    expect(script()).toContain("git merge --abort");
  });

  it("never attempts the push once merging in the remote tip has conflicted", async () => {
    mockProvider();
    const { sandbox, script } = capturingSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    const s = script();
    // The push (and the abort) both appear in the script text unconditionally; what matters is
    // that the push sits behind the same $MERGE_CONFLICT guard the abort sets, so a real
    // conflict short-circuits before ever reaching `git push`.
    expect(s.indexOf('MERGE_CONFLICT=1')).toBeLessThan(s.indexOf('if [ "$MERGE_CONFLICT" -eq 1 ]'));
    expect(s.indexOf('if [ "$MERGE_CONFLICT" -eq 1 ]')).toBeLessThan(s.indexOf("git push --no-verify"));
  });

  it("throws a distinct, actionable error when the remote branch has unrelated conflicting commits", async () => {
    mockProvider();
    const sandbox = fakeSandbox([
      { stream: "stdout", data: "CONFLICT_FILE:apps/web/src/app/(app)/activity/page.tsx\n" },
      { stream: "stdout", data: "PUSH_CONFLICT\n" },
    ]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).rejects.toThrow(
      /remote branch "agent\/session-1" already has unrelated commits.*activity\/page\.tsx.*branch name was reused/s,
    );
  });

  it("still throws the conflict error when no conflicting file names came through", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_CONFLICT\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).rejects.toThrow(
      'Cannot push: remote branch "agent/session-1" already has unrelated commits',
    );
  });

  it("throws when the push fails", async () => {
    mockProvider();
    const sandbox = fakeSandbox([
      { stream: "stderr", data: "! [rejected]\n" },
      { stream: "stdout", data: "PUSH_FAILED\n" },
    ]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).rejects.toThrow(
      "Failed to push agent changes to the remote",
    );
  });

  it("throws when the target's provider isn't registered", async () => {
    getScmProviderMock.mockReturnValue(undefined);
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).rejects.toThrow(
      'No registered SCM provider for "github"',
    );
  });

  it("mints its push token via the resolved provider, keyed on the target's own provider id", async () => {
    const mintPushToken = mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);

    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    expect(getScmProviderMock).toHaveBeenCalledWith("github");
    expect(mintPushToken).toHaveBeenCalledWith(target);
  });

  it("reports a recovered branch mismatch when the agent committed on a descendant branch that got fast-forwarded", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "BRANCH_MISMATCH:fix/53-surface-real-run-error\nPUSH_OK\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: true,
      changedFiles: [],
      branchMismatch: { agentBranch: "fix/53-surface-real-run-error" },
    });
  });

  it("reports an unrecovered branch mismatch when the agent's branch wasn't a descendant of the session branch", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "BRANCH_MISMATCH:main\nNO_CHANGES\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: false,
      changedFiles: [],
      branchMismatch: { agentBranch: "main" },
    });
  });

  it("passes the token, repo, branch, commit message, and author as env vars, not argv — the token never appears in the command itself", async () => {
    mockProvider("ghs_push");
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
      interrupt: vi.fn(),
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
