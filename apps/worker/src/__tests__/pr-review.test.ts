import { describe, expect, it, vi } from "vitest";
import type { ExecOptions, OutputChunk, SandboxProvider } from "../sandbox/types";
import type { CloneTarget } from "@agentfactory/scm";
import {
  MAX_REVIEW_DIFF_CHARS,
  checkoutPullRequest,
  isAncestor,
  parseDiffAnchors,
  parseStructuredReview,
  renderReviewAsMarkdown,
  resolveReviewRange,
  truncateDiff,
  validateReviewComments,
} from "../pr-review";

// Captures every exec() call's cmd/opts so tests can assert on the actual shell script and env
// vars sent to the sandbox, not just the marker-based stdout outcome — this is what would have
// caught a script-content regression like a credential left in .git/config on a failed clone.
interface FakeSandbox extends SandboxProvider {
  calls: Array<{ cmd: string[]; opts?: ExecOptions }>;
}

function fakeSandbox(chunks: OutputChunk[]): FakeSandbox {
  const calls: Array<{ cmd: string[]; opts?: ExecOptions }> = [];
  return {
    calls,
    create: vi.fn(),
    exec: async function* (_id: string, cmd: string[], opts?: ExecOptions) {
      calls.push({ cmd, opts });
      for (const chunk of chunks) yield chunk;
    },
    writeFiles: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    resetMemory: vi.fn(),
  };
}

const target: CloneTarget = {
  cloneUrl: "https://x-access-token:tok@github.com/acme-org/platform.git",
  remoteUrl: "https://github.com/acme-org/platform.git",
  branch: "n/a",
  repoFullName: "acme-org/platform",
  provider: "github",
  installationRef: 999,
};

describe("checkoutPullRequest", () => {
  it("succeeds when the sandbox reports CHECKOUT_OK", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "CHECKOUT_OK\n" }]);
    await expect(checkoutPullRequest(sandbox, "sandbox-1", target, 42, "main")).resolves.toBeUndefined();
  });

  it("throws when the sandbox reports a repo mismatch", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "REPO_MISMATCH\n" }]);
    await expect(checkoutPullRequest(sandbox, "sandbox-1", target, 42, "main")).rejects.toThrow(/different repository/);
  });

  it("throws when the sandbox reports no success marker", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "CHECKOUT_FAILED\n" }]);
    await expect(checkoutPullRequest(sandbox, "sandbox-1", target, 42, "main")).rejects.toThrow(/Failed to check out/);
  });

  it("resets the remote to REMOTE_URL unconditionally on the clone branch, before branching on clone status, and passes the required env vars", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "CHECKOUT_OK\n" }]);
    await checkoutPullRequest(sandbox, "sandbox-1", target, 42, "main");

    expect(sandbox.calls).toHaveLength(1);
    const [{ cmd, opts }] = sandbox.calls;
    expect(cmd[0]).toBe("sh");
    expect(cmd[1]).toBe("-c");
    const script = cmd[2];

    // The clone branch's remote reset must run unconditionally (no clone-status guard in front
    // of it) and appear, in script source order, before the point where the script decides
    // CHECKOUT_FAILED vs proceeding on a failed clone — otherwise a failed clone leaves the
    // tokenized CLONE_URL sitting in .git/config instead of being stripped back to REMOTE_URL.
    const cloneLineIndex = script.indexOf('git clone --no-checkout "$CLONE_URL" /workspace');
    const cloneResetIndex = script.indexOf('cd /workspace 2>/dev/null && git remote set-url origin "$REMOTE_URL"');
    const cloneStatusBranchIndex = script.indexOf('if [ "$CLONE_STATUS" -ne 0 ]');
    expect(cloneLineIndex).toBeGreaterThanOrEqual(0);
    expect(cloneResetIndex).toBeGreaterThan(cloneLineIndex);
    expect(cloneStatusBranchIndex).toBeGreaterThan(cloneResetIndex);

    expect(opts?.env).toMatchObject({
      CLONE_URL: target.cloneUrl,
      REMOTE_URL: target.remoteUrl,
      REPO_FULL_NAME: target.repoFullName,
      PR_NUMBER: "42",
      BASE_BRANCH: "main",
    });
  });
});

describe("isAncestor", () => {
  it("returns true when git reports the ancestor relationship", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "IS_ANCESTOR\n" }]);
    await expect(isAncestor(sandbox, "sandbox-1", "abc", "def")).resolves.toBe(true);
  });

  it("returns false otherwise", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "NOT_ANCESTOR\n" }]);
    await expect(isAncestor(sandbox, "sandbox-1", "abc", "def")).resolves.toBe(false);
  });
});

describe("resolveReviewRange", () => {
  it("reviews the whole PR on the first pass", () => {
    expect(
      resolveReviewRange({ prBaseBranch: "main", prHeadSha: "head1", lastReviewedHeadSha: undefined, lastReviewedIsAncestorOfHead: false }),
    ).toEqual({ focusBaseSha: "main", focusHeadSha: "head1", rewritten: false });
  });

  it("reviews only what's new since the last pass when history is linear", () => {
    expect(
      resolveReviewRange({ prBaseBranch: "main", prHeadSha: "head2", lastReviewedHeadSha: "head1", lastReviewedIsAncestorOfHead: true }),
    ).toEqual({ focusBaseSha: "head1", focusHeadSha: "head2", rewritten: false });
  });

  it("falls back to the whole PR and flags rewritten when history was rewritten", () => {
    expect(
      resolveReviewRange({ prBaseBranch: "main", prHeadSha: "head2", lastReviewedHeadSha: "head1", lastReviewedIsAncestorOfHead: false }),
    ).toEqual({ focusBaseSha: "main", focusHeadSha: "head2", rewritten: true });
  });
});

describe("truncateDiff", () => {
  it("returns the diff unchanged when under the cap", () => {
    expect(truncateDiff("short diff")).toEqual({ text: "short diff", truncated: false });
  });

  it("truncates with a marker when over the cap", () => {
    const big = "x".repeat(MAX_REVIEW_DIFF_CHARS + 100);
    const { text, truncated } = truncateDiff(big);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain("truncated");
  });
});

describe("parseDiffAnchors", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " context line",
    "-old line",
    "+new line one",
    "+new line two",
  ].join("\n");

  it("includes added and context lines on the new side", () => {
    const anchors = parseDiffAnchors(diff);
    expect(anchors.has("src/a.ts:10")).toBe(true); // context line
    expect(anchors.has("src/a.ts:11")).toBe(true); // new line one
    expect(anchors.has("src/a.ts:12")).toBe(true); // new line two
  });

  it("does not anchor to a deleted line's number", () => {
    const anchors = parseDiffAnchors(diff);
    // the deleted line consumed an old-side number only; no new-side line was skipped for it
    // here, but a diff with an isolated deletion must never produce a false anchor for it
    const deletionOnly = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -5,2 +5,1 @@", " kept", "-removed"].join("\n");
    expect(parseDiffAnchors(deletionOnly).size).toBe(1); // only the context line at new-side 5
  });
});

describe("parseStructuredReview", () => {
  it("parses a well-formed payload", () => {
    const raw = { summary: "ok", verdict: "comment", comments: [{ path: "a.ts", line: 1, body: "nit" }] };
    expect(parseStructuredReview(raw)).toEqual(raw);
  });

  it("throws on a missing verdict", () => {
    expect(() => parseStructuredReview({ summary: "ok", comments: [] })).toThrow(/verdict/);
  });

  it("throws on an invalid verdict value", () => {
    expect(() => parseStructuredReview({ summary: "ok", verdict: "approve", comments: [] })).toThrow(/verdict/);
  });

  it("throws on undefined input", () => {
    expect(() => parseStructuredReview(undefined)).toThrow();
  });
});

describe("validateReviewComments", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,2 @@",
    " context",
    "+added",
  ].join("\n");

  it("keeps comments anchored to a real diff line", () => {
    const review = { summary: "s", verdict: "comment" as const, comments: [{ path: "src/a.ts", line: 11, body: "nit" }] };
    const result = validateReviewComments(review, diff);
    expect(result.comments).toEqual([{ path: "src/a.ts", line: 11, body: "nit" }]);
    expect(result.summary).toBe("s");
  });

  it("folds an invalid anchor into the summary instead of dropping it", () => {
    const review = { summary: "s", verdict: "comment" as const, comments: [{ path: "src/a.ts", line: 999, body: "nit" }] };
    const result = validateReviewComments(review, diff);
    expect(result.comments).toEqual([]);
    expect(result.summary).toContain("src/a.ts:999");
    expect(result.summary).toContain("nit");
  });
});

describe("renderReviewAsMarkdown", () => {
  it("renders the summary, verdict, and comment list as markdown", () => {
    const md = renderReviewAsMarkdown({
      summary: "Looks solid.",
      verdict: "request_changes",
      comments: [{ path: "src/a.ts", line: 11, body: "consider a null check" }],
    });
    expect(md).toContain("Looks solid.");
    expect(md.toLowerCase()).toContain("request changes");
    expect(md).toContain("src/a.ts:11");
    expect(md).toContain("consider a null check");
  });
});
