import type { CloneTarget } from "@agentfactory/scm";
import type { SandboxProvider } from "./sandbox/types";

// Matches eval-judge.ts's MAX_ARTEFACT_CHARS — same kind of text (a diff), same codebase, one
// number to reason about rather than a second independently-chosen cap.
export const MAX_REVIEW_DIFF_CHARS = 120_000;

export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    verdict: { type: "string", enum: ["comment", "request_changes"] },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          body: { type: "string" },
        },
        required: ["path", "line", "body"],
      },
    },
  },
  required: ["summary", "verdict", "comments"],
} as const;

export interface StructuredReview {
  summary: string;
  verdict: "comment" | "request_changes";
  comments: Array<{ path: string; line: number; body: string }>;
}

// Runtime validation of the SDK's structured_output field, which is typed `unknown` — the SDK's
// own outputFormat retry loop makes a malformed shape unlikely, but worker.ts still needs to
// trust this before using it for anything, so this throws a clear error rather than casting.
export function parseStructuredReview(raw: unknown): StructuredReview {
  if (typeof raw !== "object" || raw === null) throw new Error("Structured review output is not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string") throw new Error("Structured review output is missing 'summary'");
  if (obj.verdict !== "comment" && obj.verdict !== "request_changes") {
    throw new Error(`Structured review output has an invalid 'verdict': ${JSON.stringify(obj.verdict)}`);
  }
  if (!Array.isArray(obj.comments)) throw new Error("Structured review output is missing 'comments'");
  const comments = obj.comments.map((c, i) => {
    if (typeof c !== "object" || c === null) throw new Error(`comments[${i}] is not an object`);
    const co = c as Record<string, unknown>;
    if (typeof co.path !== "string") throw new Error(`comments[${i}].path is not a string`);
    if (typeof co.line !== "number") throw new Error(`comments[${i}].line is not a number`);
    if (typeof co.body !== "string") throw new Error(`comments[${i}].body is not a string`);
    return { path: co.path, line: co.line, body: co.body };
  });
  return { summary: obj.summary, verdict: obj.verdict, comments };
}

// Truncates diff text for the prompt only — never for validation, which always uses the full
// diff (see validateReviewComments). The agent is told in its environment segment when this
// happened and pointed at `git diff` for the rest.
export function truncateDiff(diffText: string): { text: string; truncated: boolean } {
  if (diffText.length <= MAX_REVIEW_DIFF_CHARS) return { text: diffText, truncated: false };
  return { text: `${diffText.slice(0, MAX_REVIEW_DIFF_CHARS)}\n…[diff truncated]`, truncated: true };
}

// Every "path:line" position on the NEW side of a unified diff that a GitHub inline comment can
// legally anchor to — added ('+') and context (' ') lines, per a hunk header's new-file range.
// Deleted ('-') lines never advance the new-side counter and are never valid anchors (v1 does
// not support commenting on deleted lines — see the design spec).
export function parseDiffAnchors(diffText: string): Set<string> {
  const anchors = new Set<string>();
  let currentPath: string | undefined;
  let newLine = 0;
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const fileHeaderRe = /^\+\+\+ b\/(.+)$/;

  for (const line of diffText.split("\n")) {
    const fileMatch = fileHeaderRe.exec(line);
    if (fileMatch) {
      currentPath = fileMatch[1];
      continue;
    }
    const hunkMatch = hunkHeaderRe.exec(line);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }
    if (!currentPath) continue;
    if (line.startsWith("+")) {
      anchors.add(`${currentPath}:${newLine}`);
      newLine++;
    } else if (line.startsWith(" ")) {
      anchors.add(`${currentPath}:${newLine}`);
      newLine++;
    }
    // '-' lines: do not advance newLine, never anchor.
  }
  return anchors;
}

export interface ValidatedComment {
  path: string;
  line: number;
  body: string;
}

export interface ValidatedReview {
  summary: string;
  verdict: "comment" | "request_changes";
  comments: ValidatedComment[];
}

// Splits the agent's comments into those that land on a real diff line (kept as-is) and those
// that don't (folded into the summary as "path:line — body" rather than silently dropped —
// nothing the agent said is lost, it just can't be anchored on GitHub). `fullDiffText` must be
// the PR's whole base→head diff, not just the range the agent was asked to focus on: GitHub
// anchors comments against the full diff at head, so a remark about a line changed in an
// earlier pass is still a valid anchor.
export function validateReviewComments(review: StructuredReview, fullDiffText: string): ValidatedReview {
  const anchors = parseDiffAnchors(fullDiffText);
  const comments: ValidatedComment[] = [];
  const invalid: string[] = [];

  for (const c of review.comments) {
    if (anchors.has(`${c.path}:${c.line}`)) {
      comments.push(c);
    } else {
      invalid.push(`${c.path}:${c.line} — ${c.body}`);
    }
  }

  const summary = invalid.length > 0 ? `${review.summary}\n\n${invalid.join("\n")}` : review.summary;
  return { summary, verdict: review.verdict, comments };
}

export function renderReviewAsMarkdown(review: ValidatedReview): string {
  const verdictLabel = review.verdict === "request_changes" ? "Request changes" : "Comment";
  const lines = [`**Verdict: ${verdictLabel}**`, "", review.summary];
  if (review.comments.length > 0) {
    lines.push("", "**Inline comments:**");
    for (const c of review.comments) {
      lines.push(`- \`${c.path}:${c.line}\` — ${c.body}`);
    }
  }
  return lines.join("\n");
}

export interface ReviewRange {
  focusBaseSha: string;
  focusHeadSha: string;
  rewritten: boolean;
}

// Decides what to tell the agent to focus on. Validation (validateReviewComments) always uses
// the full PR diff regardless of what this returns — this only narrows the agent's *prompt*.
export function resolveReviewRange(params: {
  prBaseBranch: string;
  prHeadSha: string;
  lastReviewedHeadSha?: string;
  lastReviewedIsAncestorOfHead: boolean;
}): ReviewRange {
  const { prBaseBranch, prHeadSha, lastReviewedHeadSha, lastReviewedIsAncestorOfHead } = params;
  if (!lastReviewedHeadSha) {
    return { focusBaseSha: prBaseBranch, focusHeadSha: prHeadSha, rewritten: false };
  }
  if (!lastReviewedIsAncestorOfHead) {
    return { focusBaseSha: prBaseBranch, focusHeadSha: prHeadSha, rewritten: true };
  }
  return { focusBaseSha: lastReviewedHeadSha, focusHeadSha: prHeadSha, rewritten: false };
}

// Checks out a PR's current head into a local `review/pr-N` branch, force-checked-out on every
// call so a warm sandbox always lands on the current head and discards whatever a prior pass's
// exploration left behind. Clones into /workspace first if it isn't already a git checkout —
// mirrors cloneIntoSandbox's REPO_MISMATCH guard (apps/worker/src/scm-provider.ts) but never
// creates an agent/session-* branch, since a review run never commits or pushes. Fetches
// GitHub's `refs/pull/N/head`, which works identically for same-repo and fork PRs — there is no
// separate "is this a fork" branch in this logic. Also fetches `baseBranch` into a local
// origin-tracking ref so the agent's own optional `git diff`/exploration in the sandbox has a
// fresh base to compare against — this has no bearing on what actually gets posted to GitHub,
// since both the prompt diff and validateReviewComments' anchor diff come from
// ScmProvider.fetchCommitRangeDiff (GitHub's server-side compare API on sha/branch strings), not
// from this local checkout. target.cloneUrl already carries a token minted this run (by
// resolveCloneTarget); it's used for the fetch and the remote is reset to target.remoteUrl
// (credential-free) immediately after, unconditionally — including on a failed clone, mirroring
// cloneIntoSandbox's CLONE_STATUS/remote-reset/branch-after ordering (apps/worker/src/scm-provider.ts)
// so a partial clone never leaves the tokenized URL sitting in .git/config.
export async function checkoutPullRequest(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
  prNumber: number,
  baseBranch: string,
): Promise<void> {
  const script = `
if [ -d /workspace/.git ]; then
  CURRENT_REMOTE=$(git -C /workspace remote get-url origin 2>/dev/null)
  case "$CURRENT_REMOTE" in
    *"$REPO_FULL_NAME.git") : ;;
    *) echo REPO_MISMATCH; exit 0 ;;
  esac
else
  git clone --no-checkout "$CLONE_URL" /workspace
  CLONE_STATUS=$?
  cd /workspace 2>/dev/null && git remote set-url origin "$REMOTE_URL"
  if [ "$CLONE_STATUS" -ne 0 ]; then echo CHECKOUT_FAILED; exit 0; fi
fi
cd /workspace || { echo CHECKOUT_FAILED; exit 0; }
git remote set-url origin "$CLONE_URL"
git fetch origin "pull/$PR_NUMBER/head:review/pr-$PR_NUMBER" "$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" --force --quiet
FETCH_STATUS=$?
git remote set-url origin "$REMOTE_URL"
if [ "$FETCH_STATUS" -ne 0 ]; then echo CHECKOUT_FAILED; exit 0; fi
git checkout -f "review/pr-$PR_NUMBER"
if [ $? -ne 0 ]; then echo CHECKOUT_FAILED; exit 0; fi
echo CHECKOUT_OK`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: {
      CLONE_URL: target.cloneUrl,
      REMOTE_URL: target.remoteUrl,
      REPO_FULL_NAME: target.repoFullName,
      PR_NUMBER: String(prNumber),
      BASE_BRANCH: baseBranch,
    },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  if (stdout.includes("REPO_MISMATCH")) {
    throw new Error(`Sandbox workspace already contains a different repository than "${target.repoFullName}"`);
  }
  if (!stdout.includes("CHECKOUT_OK")) {
    throw new Error(`Failed to check out pull request #${prNumber} into sandbox workspace`);
  }
}

// Whether `ancestorSha` is an ancestor of `descendantSha` on the checked-out repo — decides
// whether a re-review's range can be incremental (resolveReviewRange) or must fall back to the
// whole PR after a force-push.
export async function isAncestor(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  ancestorSha: string,
  descendantSha: string,
): Promise<boolean> {
  const script = `
cd /workspace || { echo NOT_ANCESTOR; exit 0; }
if git merge-base --is-ancestor "$ANCESTOR_SHA" "$DESCENDANT_SHA" 2>/dev/null; then
  echo IS_ANCESTOR
else
  echo NOT_ANCESTOR
fi`;
  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { ANCESTOR_SHA: ancestorSha, DESCENDANT_SHA: descendantSha },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }
  return stdout.includes("IS_ANCESTOR");
}
