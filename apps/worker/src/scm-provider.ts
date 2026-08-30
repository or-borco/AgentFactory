import jwt from "jsonwebtoken";
import { listConnections } from "@agentfactory/db";
import type { RunCommitRange } from "@agentfactory/core";
import type { SandboxProvider } from "./sandbox/types";

const GITHUB_API = "https://api.github.com";

function privateKey(): string {
  const key = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!key) throw new Error("GITHUB_APP_PRIVATE_KEY is not set");
  // .env files can't hold real newlines in a single-line value, so the key is stored with
  // literal "\n" escapes and unescaped here before signing.
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

function appId(): string {
  const id = process.env.GITHUB_APP_ID;
  if (!id) throw new Error("GITHUB_APP_ID is not set");
  return id;
}

// Duplicated from apps/web/src/server/github-app.ts rather than imported — apps/worker and
// apps/web are separate processes/packages with no shared-code path between them today, and
// this is ~20 lines. Revisit if a third consumer needs it.
function signAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: appId() }, privateKey(), { algorithm: "RS256" });
}

async function getInstallationToken(installationId: number): Promise<string> {
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signAppJwt()}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API installation token mint failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function listInstallationRepoNames(installationId: number): Promise<string[]> {
  const token = await getInstallationToken(installationId);
  const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API /installation/repositories failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { repositories: Array<{ full_name: string }> };
  return body.repositories.map((r) => r.full_name);
}

export interface CloneTarget {
  cloneUrl: string;
  branch: string;
  repoFullName: string;
  installationId: number;
}

// Finds which of the org's GitHub connections has access to repoFullName — the same org-scoping
// check backs both cloning/pushing (resolveCloneTarget) and API reads like fetchIssue below, so a
// repo outside every one of the org's installations is invisible to that org either way.
async function findInstallationForRepo(orgId: number, repoFullName: string): Promise<number | undefined> {
  // Fail fast and loud on a misconfigured app — appId()/privateKey() already throw a clear
  // "X is not set" error. Checked here, before the loop below, so that error can't get
  // swallowed by the per-connection catch and misreported as "repo not accessible", which is a
  // completely different (and much more confusing) problem for whoever's debugging a failed run.
  appId();
  privateKey();

  const githubConnections = (await listConnections(orgId)).filter((c) => c.provider === "github");

  for (const connection of githubConnections) {
    const installationId = connection.config.installationId;
    if (typeof installationId !== "number") continue;

    const repoNames = await listInstallationRepoNames(installationId).catch((): string[] => []);
    if (repoNames.includes(repoFullName)) return installationId;
  }
  return undefined;
}

// Finds which of the org's GitHub connections has access to repoFullName, and mints a fresh
// installation token embedded directly in the clone URL. Nothing here is persisted — the token
// is used once, for one clone, and expires on its own (~1hr) per ARCHITECTURE.md §5/§6.
export async function resolveCloneTarget(
  orgId: number,
  repoFullName: string,
  branch: string,
): Promise<CloneTarget | undefined> {
  const installationId = await findInstallationForRepo(orgId, repoFullName);
  if (installationId === undefined) return undefined;

  const token = await getInstallationToken(installationId);
  return {
    cloneUrl: `https://x-access-token:${token}@github.com/${repoFullName}.git`,
    branch,
    repoFullName,
    installationId,
  };
}

export interface GitHubIssue {
  title: string;
  body: string;
}

const ISSUE_URL_RE = /github\.com\/([^/\s]+\/[^/\s.]+)\/issues\/(\d+)/;

// Task descriptions often are (or contain) a GitHub issue link — e.g. "https://github.com/
// acme/widgets/issues/37" — pasted in as "what needs to be done". This is the only place that
// link gets parsed; nothing else in the codebase looks for issue references today.
export function parseIssueReference(text: string): { repoFullName: string; issueNumber: number } | undefined {
  const match = ISSUE_URL_RE.exec(text);
  if (!match) return undefined;
  return { repoFullName: match[1], issueNumber: Number(match[2]) };
}

// Fetches an issue's title/body via the same per-org installation lookup as resolveCloneTarget,
// so a task can only ever pull issue content from a repo the org's own GitHub App installation
// can see — org A can't reach org B's issues this way any more than it can clone org B's repo.
// Runs on the worker host (which already holds the App's private key), not inside the sandbox —
// the sandbox has no GitHub credentials or HTTP client, by design (see cloneIntoSandbox's
// comment on why the agent never gets a usable token).
export async function fetchIssue(
  orgId: number,
  repoFullName: string,
  issueNumber: number,
): Promise<GitHubIssue | undefined> {
  const installationId = await findInstallationForRepo(orgId, repoFullName);
  if (installationId === undefined) return undefined;

  const token = await getInstallationToken(installationId);
  const res = await fetch(`${GITHUB_API}/repos/${repoFullName}/issues/${issueNumber}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API issue fetch failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const issue = (await res.json()) as { title: string; body: string | null };
  return { title: issue.title, body: issue.body ?? "" };
}

// Resolves a repo's default branch HEAD sha via the GitHub API alone, with no sandbox and no
// clone — used by the repo-map pre-warm job to check whether a commit is already cached before
// paying for a container. Mirrors openDraftPullRequest's own default-branch lookup.
export async function resolveDefaultBranchSha(orgId: number, repoFullName: string): Promise<string | undefined> {
  const installationId = await findInstallationForRepo(orgId, repoFullName);
  if (installationId === undefined) return undefined;

  const token = await getInstallationToken(installationId);
  const repoRes = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!repoRes.ok) {
    throw new Error(`GitHub API repo lookup failed: ${repoRes.status} ${await repoRes.text().catch(() => "")}`);
  }
  const { default_branch: branch } = (await repoRes.json()) as { default_branch: string };

  const commitRes = await fetch(`${GITHUB_API}/repos/${repoFullName}/commits/${branch}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!commitRes.ok) {
    throw new Error(`GitHub API commit lookup failed: ${commitRes.status} ${await commitRes.text().catch(() => "")}`);
  }
  const { sha } = (await commitRes.json()) as { sha: string };
  return sha;
}

// The eval judge's artefact when a run committed: the diff of exactly the commits THAT run
// pushed, straight from the GitHub compare API in raw diff form.
//
// The range comes from the run itself (Run.commitRange, recorded at push time), never from the
// branch's current state — a session's branch accumulates every run's work, so comparing the
// branch against the default branch would grade run 1 against run 3's commits. Both ends are
// commit shas, so no ref-encoding question arises.
//
// There is no "not found" return value here, deliberately. Whether a run committed is answered
// by whether it recorded a range, not by what GitHub says; a recorded range whose commits cannot
// be fetched means the artefact is unavailable, and every non-OK response — 404 included —
// throws so the caller fails the eval rather than silently grading the run's chat reply instead.
export async function fetchCommitRangeDiff(target: CloneTarget, range: RunCommitRange): Promise<string> {
  const token = await getInstallationToken(target.installationId);

  const compareRes = await fetch(
    `${GITHUB_API}/repos/${target.repoFullName}/compare/${range.baseSha}...${range.headSha}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3.diff" } },
  );
  if (!compareRes.ok) {
    throw new Error(`GitHub API compare failed: ${compareRes.status} ${await compareRes.text().catch(() => "")}`);
  }
  return compareRes.text();
}

// Clones into /workspace on first use only — the same container is reused across a session's
// later runs (worker.ts's ensureSandbox), and re-cloning would wipe any uncommitted changes an
// earlier turn made. When /workspace already has a repo, its remote is checked against the
// *current* target rather than assumed correct — a task's codebase can only be set once through
// today's UI, but nothing stops a direct API call (or a future edit UI) from changing it after
// the session already cloned a different repo, and silently continuing to work in the stale one
// would be a much worse failure mode than erroring clearly. Exit status is read back via an
// echoed sentinel rather than a real exit code, matching the existing pattern in
// agent-runtime.ts (SandboxProvider.exec has no exit-code channel). The token lives only in an
// env var passed to the exec, never in argv — and once the clone succeeds, the remote is
// immediately rewritten to a plain, credential-free URL. Leaving the token embedded in
// .git/config would sit there for the agent's entire turn, readable and directly usable by
// anything with Bash access (the agent has full unrestricted tool access — no canUseTool gate
// exists) to push anywhere or call GitHub's API on its own initiative — a real gap this closes,
// not a hypothetical one. The set-url runs unconditionally (even if checkout fails) so a
// credential is never left behind on a partial failure.
export async function cloneIntoSandbox(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
): Promise<void> {
  const script = `
if [ -d /workspace/.git ]; then
  CURRENT_REMOTE=$(cd /workspace && git remote get-url origin 2>/dev/null)
  case "$CURRENT_REMOTE" in
    *"github.com/$REPO_FULL_NAME.git") echo ALREADY_CLONED ;;
    *) echo REPO_MISMATCH ;;
  esac
else
  git clone "$CLONE_URL" /workspace
  CLONE_STATUS=$?
  cd /workspace 2>/dev/null && git checkout -b "$BRANCH_NAME"
  CHECKOUT_STATUS=$?
  cd /workspace 2>/dev/null && git remote set-url origin "https://github.com/$REPO_FULL_NAME.git"
  if [ "$CLONE_STATUS" -eq 0 ] && [ "$CHECKOUT_STATUS" -eq 0 ]; then echo CLONE_OK; else echo CLONE_FAILED; fi
fi`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { CLONE_URL: target.cloneUrl, BRANCH_NAME: target.branch, REPO_FULL_NAME: target.repoFullName },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  if (stdout.includes("REPO_MISMATCH")) {
    throw new Error(
      `Sandbox workspace already contains a different repository than "${target.repoFullName}" — ` +
        "this session was likely started against a different task codebase and can't be reused for this one",
    );
  }
  const succeeded = stdout.includes("CLONE_OK") || stdout.includes("ALREADY_CLONED");
  if (!succeeded) {
    throw new Error("Failed to clone repository into sandbox workspace");
  }
}

// Commits and pushes only if the agent actually changed something — a read-only turn (e.g. "what
// does this file do?") leaves /workspace clean, and there's nothing to push or open a PR for.
// Returns whether anything was pushed. This only ever runs *after* the agent's turn has already
// finished (called from worker.ts, not from anything the agent invokes), so it mints its own
// fresh token rather than relying on anything left over from cloneIntoSandbox — which no longer
// leaves a usable credential behind anyway (see that function's comment). The token is attached
// to the remote only for the duration of the push itself and stripped again immediately
// afterward, unconditionally (even on push failure), so a later turn in the same session never
// finds a working credential sitting in .git/config either.
export interface PushResult {
  pushed: boolean;
  // Paths committed in this turn, per `git diff-tree` on the new commit — not the whole repo
  // tree, so callers (the workspace-snapshot UI, the PR body) can show just what changed instead
  // of every file the clone happened to bring in.
  changedFiles: string[];
  // The commits this push added to target.branch, as a RunCommitRange. Absent when nothing was
  // pushed, and also when the sandbox could not name a base (a branch with no remote counterpart
  // and no origin/HEAD) — in which case the range is genuinely unknown and must not be guessed.
  commitRange?: RunCommitRange;
  // Set whenever the agent ended its turn checked out on a branch other than target.branch (it
  // has full unrestricted bash access — nothing stops it running `git checkout -b`). When set,
  // `agentBranch` is whatever branch it was actually on. If that branch was a descendant of
  // target.branch, the script fast-forwards target.branch onto it before continuing (see the
  // BRANCH_MISMATCH marker below) and `pushed` reflects the recovered push; otherwise nothing is
  // touched and `pushed` stays false — the caller (worker.ts) surfaces either outcome as an event
  // so it's never silently lost like it was for T-047.
  branchMismatch?: { agentBranch: string };
}

export async function pushChangesIfDirty(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
  commitMessage: string,
  authorName: string,
): Promise<PushResult> {
  const token = await getInstallationToken(target.installationId);

  const script = `
cd /workspace || { echo PUSH_FAILED; exit 0; }

CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "$BRANCH_NAME" ]; then
  echo "BRANCH_MISMATCH:$CURRENT_BRANCH"
  # Only ever fast-forward — never rewrite history. If $BRANCH_NAME isn't an ancestor of what's
  # checked out now (agent ended up somewhere unrelated/behind), leave it alone and just check it
  # back out, so the next turn in this session still starts from the canonical branch.
  if git merge-base --is-ancestor "$BRANCH_NAME" HEAD 2>/dev/null; then
    git branch -f "$BRANCH_NAME" HEAD
  fi
  git checkout "$BRANCH_NAME"
fi

# "Anything to push" means uncommitted edits, or commits already made that the remote doesn't
# have yet (the agent may have committed its own work, on this branch or the one folded in
# above) — not just a dirty working tree, which is all the old check looked at.
UPSTREAM_BASE=$(git rev-parse --verify "origin/$BRANCH_NAME" 2>/dev/null || git rev-parse --verify origin/HEAD 2>/dev/null)
AHEAD=""
if [ -n "$UPSTREAM_BASE" ]; then
  AHEAD=$(git rev-list "$UPSTREAM_BASE..HEAD" 2>/dev/null)
fi

if [ -z "$(git status --porcelain)" ] && [ -z "$AHEAD" ]; then
  echo NO_CHANGES
else
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git -c user.email="agent@agentfactory.local" -c user.name="$AUTHOR_NAME" commit -m "$COMMIT_MESSAGE"
    COMMIT_STATUS=$?
  else
    COMMIT_STATUS=0
  fi
  git diff-tree --no-commit-id --name-only -r HEAD | sed 's/^/CHANGED_FILE:/'
  # Both ends of what this run is adding. BASE_SHA is the branch as the remote knew it before
  # this push (or the default branch, for the session's first run); HEAD_SHA is where it lands
  # after committing. Emitted here rather than derived later because the branch keeps moving:
  # once the next run pushes, nothing on the branch can say which commits were this run's.
  if [ -n "$UPSTREAM_BASE" ]; then echo "BASE_SHA:$UPSTREAM_BASE"; fi
  echo "HEAD_SHA:$(git rev-parse HEAD)"
  git remote set-url origin "https://x-access-token:$PUSH_TOKEN@github.com/$REPO_FULL_NAME.git"
  # --no-verify: the repo's local pre-push hook (.husky/pre-push) assumes a developer's own
  # machine (it hardcodes a Homebrew PATH and shells out to pnpm) and the sandbox has neither
  # pnpm nor installed dependencies to run it — it always dies with "pnpm: not found" before the
  # push even reaches GitHub. This is the hook's own documented bypass, not a real test skip:
  # GitHub Actions (test.yml) still runs the full suite on the pushed branch, and a human reviews
  # the draft PR before merge either way.
  git push --no-verify -u origin "$BRANCH_NAME"
  PUSH_STATUS=$?
  git remote set-url origin "https://github.com/$REPO_FULL_NAME.git"
  if [ "$COMMIT_STATUS" -eq 0 ] && [ "$PUSH_STATUS" -eq 0 ]; then echo PUSH_OK; else echo PUSH_FAILED; fi
fi`;

  let stdout = "";
  let stderr = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: {
      BRANCH_NAME: target.branch,
      REPO_FULL_NAME: target.repoFullName,
      COMMIT_MESSAGE: commitMessage,
      AUTHOR_NAME: authorName,
      PUSH_TOKEN: token,
    },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
    else stderr += chunk.data;
  }

  const mismatchMatch = /^BRANCH_MISMATCH:(.*)$/m.exec(stdout);
  const branchMismatch = mismatchMatch ? { agentBranch: mismatchMatch[1] } : undefined;

  if (stdout.includes("NO_CHANGES")) return { pushed: false, changedFiles: [], branchMismatch };
  if (stdout.includes("PUSH_OK")) {
    const changedFiles = stdout
      .split("\n")
      .filter((line) => line.startsWith("CHANGED_FILE:"))
      .map((line) => line.slice("CHANGED_FILE:".length).trim())
      .filter(Boolean);
    const baseSha = /^BASE_SHA:(\S+)$/m.exec(stdout)?.[1];
    const headSha = /^HEAD_SHA:(\S+)$/m.exec(stdout)?.[1];
    // Both ends or neither: half a range cannot be compared, and a partial one would invite a
    // caller to fill in the other side from the branch tip — exactly the per-session guess this
    // field exists to replace.
    const commitRange = baseSha && headSha ? { baseSha, headSha } : undefined;
    return { pushed: true, changedFiles, branchMismatch, commitRange };
  }
  throw new Error(`Failed to push agent changes to the remote: ${stderr.trim() || stdout.trim()}`);
}

// The agent's summary is written from inside the sandbox, where the repo is checked out at
// /workspace — a container-internal mount point that means nothing on GitHub (and isn't even
// accurate there: the file is at the repo root, not under a "/workspace" directory). Strip it
// out before anything the agent wrote reaches a PR body meant for human reviewers.
function stripSandboxPaths(text: string): string {
  return text.replace(/\/workspace\//g, "").replace(/\/workspace\b/g, "the repo root");
}

// Composes an informative PR body from what the run actually produced, rather than the one-line
// "opened automatically for task T-xxx" placeholder — reviewers need the task's own description
// and the agent's own account of what it did to judge a draft PR without reading every diff line.
export function buildPullRequestBody(params: {
  taskRef: string;
  taskDescription: string;
  summary: string;
  changedFiles: string[];
}): string {
  const sections = [`Opened automatically by AgentFactory for task ${params.taskRef}.`];
  if (params.summary.trim()) sections.push(`## What changed\n${stripSandboxPaths(params.summary.trim())}`);
  if (params.taskDescription.trim()) sections.push(`## Task\n${params.taskDescription.trim()}`);
  if (params.changedFiles.length > 0) {
    sections.push(`## Files changed\n${params.changedFiles.map((f) => `- \`${f}\``).join("\n")}`);
  }
  return sections.join("\n\n");
}

export interface OpenedPullRequest {
  number: number;
  url: string;
}

// Opens a draft PR against the repo's actual default branch (fetched fresh rather than assumed
// "main" — plenty of repos default to something else). draft:true and a branch scoped to
// agent/session-* are the structural half of blast-radius containment: the app's own permissions
// (contents:write, pull_requests:write, no admin — see the GitHub App manifest) mean this token
// physically cannot merge or touch a protected branch even if something upstream were wrong.
export async function openDraftPullRequest(
  installationId: number,
  repoFullName: string,
  branch: string,
  title: string,
  body: string,
): Promise<OpenedPullRequest> {
  const token = await getInstallationToken(installationId);

  const repoRes = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!repoRes.ok) {
    throw new Error(`GitHub API repo lookup failed: ${repoRes.status} ${await repoRes.text().catch(() => "")}`);
  }
  const { default_branch: base } = (await repoRes.json()) as { default_branch: string };

  const prRes = await fetch(`${GITHUB_API}/repos/${repoFullName}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, head: branch, base, body, draft: true }),
  });
  if (!prRes.ok) {
    throw new Error(`GitHub API PR creation failed: ${prRes.status} ${await prRes.text().catch(() => "")}`);
  }
  const pr = (await prRes.json()) as { number: number; html_url: string };
  return { number: pr.number, url: pr.html_url };
}
