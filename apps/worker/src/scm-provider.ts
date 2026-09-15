import type { RunCommitRange } from "@agentfactory/core";
import { getScmProvider, parseIssueReferenceAcrossProviders, resolveScmConnection } from "@agentfactory/scm";
import type { CloneTarget, OpenedPullRequest, ScmIssue } from "@agentfactory/scm";
import type { SandboxProvider } from "./sandbox/types";
import { TASK_DOCUMENT_EXCLUDE_PATTERN } from "./task-document-paths";
import { SKILL_EXCLUDE_PATTERN } from "./skill-paths";

export type { CloneTarget, OpenedPullRequest };
export type GitHubIssue = ScmIssue;

// Every path a sandbox checkout writes into that must never end up in the user's PR. Anything
// added here also needs .git/info/exclude taught about it in cloneIntoSandbox below.
const GIT_EXCLUDE_PATTERNS = [TASK_DOCUMENT_EXCLUDE_PATTERN, SKILL_EXCLUDE_PATTERN];

// Resolves which of the org's connected SCM providers/connections has access to repoFullName,
// then delegates to that provider's own clone-target resolution. Kept as a same-named,
// same-signature export — rather than inlining resolveScmConnection at each call site — so
// worker.ts, eval-artefact.ts, and repo-map.ts (all written against this exact signature)
// never had to change for this migration, and won't need to change again when a second
// provider ships either.
export async function resolveCloneTarget(
  orgId: number,
  repoFullName: string,
  branch: string,
): Promise<CloneTarget | undefined> {
  const resolved = await resolveScmConnection(orgId, repoFullName);
  if (!resolved) return undefined;
  return resolved.provider.resolveCloneTarget(resolved.connection, repoFullName, branch);
}

export function parseIssueReference(text: string): { repoFullName: string; issueNumber: number } | undefined {
  return parseIssueReferenceAcrossProviders(text);
}

// Fetches an issue's title/body via the same per-org connection lookup as resolveCloneTarget,
// so a task can only ever pull issue content from a repo the org's own connection can see.
export async function fetchIssue(
  orgId: number,
  repoFullName: string,
  issueNumber: number,
): Promise<GitHubIssue | undefined> {
  const resolved = await resolveScmConnection(orgId, repoFullName);
  if (!resolved) return undefined;
  return resolved.provider.fetchIssue(resolved.connection, repoFullName, issueNumber);
}

// Resolves a repo's default branch HEAD sha via the provider's API alone, with no sandbox and
// no clone — used by the repo-map pre-warm job to check whether a commit is already cached
// before paying for a container.
export async function resolveDefaultBranchSha(orgId: number, repoFullName: string): Promise<string | undefined> {
  const resolved = await resolveScmConnection(orgId, repoFullName);
  if (!resolved) return undefined;
  return resolved.provider.resolveDefaultBranchSha(resolved.connection, repoFullName);
}

// The eval judge's artefact when a run committed: the diff of exactly the commits that run
// pushed. `target` was already resolved (at clone time) against a specific provider — its own
// `provider` tag is what routes this call back to the right adapter, since there is no
// orgId/Connection available here to re-resolve one.
export async function fetchCommitRangeDiff(target: CloneTarget, range: RunCommitRange): Promise<string> {
  const provider = getScmProvider(target.provider);
  if (!provider) throw new Error(`No registered SCM provider for "${target.provider}"`);
  return provider.fetchCommitRangeDiff(target, range);
}

// Opens a draft PR. Unlike the other wrappers above, this one needs a live Connection (not
// just an opaque target) — re-resolves it from orgId + repoFullName, the same way
// resolveCloneTarget did at clone time.
export async function openDraftPullRequest(
  orgId: number,
  repoFullName: string,
  branch: string,
  title: string,
  body: string,
): Promise<OpenedPullRequest> {
  const resolved = await resolveScmConnection(orgId, repoFullName);
  if (!resolved) throw new Error(`No connected SCM provider can access repo "${repoFullName}"`);
  return resolved.provider.openDraftPullRequest(resolved.connection, repoFullName, branch, title, body);
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
// immediately rewritten to a plain, credential-free URL (target.remoteUrl — provider-agnostic,
// unlike the old hardcoded github.com). Leaving the token embedded in .git/config would sit
// there for the agent's entire turn, readable and directly usable by anything with Bash access
// (the agent has full unrestricted tool access — no canUseTool gate exists) to push anywhere or
// call the provider's API on its own initiative — a real gap this closes, not a hypothetical
// one. The set-url runs unconditionally (even if checkout fails) so a credential is never left
// behind on a partial failure.
export async function cloneIntoSandbox(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
): Promise<void> {
  const script = `
# Makes git blind to the directories task documents and pinned skills are materialised into (see
# task-documents.ts and skills-materialize.ts). Load-bearing, not hygiene: pushChangesIfDirty runs
# \`git add -A\` and decides whether there is anything to push from \`git status --porcelain\`, so
# without this an attached document or a materialised skill would be committed into the user's
# pull request, and merely attaching/pinning one would make a run that changed nothing look dirty.
# .git/info/exclude is per-clone and never committed — a .gitignore would itself show up in the
# diff.
#
# Idempotent (each pattern is checked independently before being appended) and applied on the
# already-cloned path too, so a sandbox created before either of these shipped picks up the
# missing pattern on its session's next run rather than pushing a stray directory once.
ensure_context_dir_excluded() {
  [ -d /workspace/.git ] || return 0
  mkdir -p /workspace/.git/info
  for pattern in ${GIT_EXCLUDE_PATTERNS.map((p) => `'${p}'`).join(" ")}; do
    grep -qxF "$pattern" /workspace/.git/info/exclude 2>/dev/null || printf '%s\\n' "$pattern" >> /workspace/.git/info/exclude
  done
}

if [ -d /workspace/.git ]; then
  CURRENT_REMOTE=$(cd /workspace && git remote get-url origin 2>/dev/null)
  case "$CURRENT_REMOTE" in
    "$REMOTE_URL") ensure_context_dir_excluded; echo ALREADY_CLONED ;;
    *) echo REPO_MISMATCH ;;
  esac
else
  git clone "$CLONE_URL" /workspace
  CLONE_STATUS=$?
  cd /workspace 2>/dev/null && git checkout -b "$BRANCH_NAME"
  CHECKOUT_STATUS=$?
  cd /workspace 2>/dev/null && git remote set-url origin "$REMOTE_URL"
  ensure_context_dir_excluded
  if [ "$CLONE_STATUS" -eq 0 ] && [ "$CHECKOUT_STATUS" -eq 0 ]; then echo CLONE_OK; else echo CLONE_FAILED; fi
fi`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { CLONE_URL: target.cloneUrl, REMOTE_URL: target.remoteUrl, BRANCH_NAME: target.branch },
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

export interface RepoSyncResult {
  status: "up_to_date" | "synced" | "skipped_dirty" | "skipped_conflict" | "skipped_fetch_failed";
  commitsMerged?: number;
  conflictingFiles?: string[];
}

// Runs on every run, right after cloneIntoSandbox — including the run that just did the actual
// first-time clone, where it's a correct, cheap no-op (HEAD already is origin/HEAD). A warm
// sandbox otherwise never re-fetches after its initial clone (see cloneIntoSandbox's
// ALREADY_CLONED path above), so a task's checkout can silently drift behind the default branch
// for as long as its session stays warm — this is what closes that gap, without requiring any
// task to declare a dependency on any other.
//
// Reuses target.cloneUrl's already-embedded token (minted moments earlier by resolveCloneTarget
// for this same run) rather than minting a new one, and strips it again immediately after the
// fetch — same inject-use-strip pattern pushChangesIfDirty uses below, for the same reason: never
// leave a usable credential sitting in the sandbox for the agent to find.
//
// Merges, never rebases: pushChangesIfDirty's own push is a plain, non-force `git push`, which
// only stays a fast-forward if the branch's existing tip remains an ancestor of the new HEAD. A
// merge preserves that; a rebase would rewrite history and break the next push.
//
// A dirty working tree (only expected if a prior run crashed before reaching its own push step)
// is left alone rather than stashed — git stash pop has no equivalent to `git merge --abort`'s
// clean restore, and this case self-heals on its own once the tree is clean on a later run.
export async function syncWithDefaultBranch(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
): Promise<RepoSyncResult> {
  const script = `
cd /workspace || { echo SYNC_SKIPPED_FETCH_FAILED; exit 0; }
git remote set-url origin "$CLONE_URL"
git fetch origin --quiet
FETCH_STATUS=$?
git remote set-url origin "$REMOTE_URL"
if [ "$FETCH_STATUS" -ne 0 ]; then echo SYNC_SKIPPED_FETCH_FAILED; exit 0; fi

if git merge-base --is-ancestor origin/HEAD HEAD 2>/dev/null; then
  echo SYNC_UP_TO_DATE
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo SYNC_SKIPPED_DIRTY
  exit 0
fi

BEFORE_SHA=$(git rev-parse HEAD)
if git merge --no-edit origin/HEAD >/dev/null 2>&1; then
  echo "SYNC_OK:$(git rev-list --count "$BEFORE_SHA..HEAD")"
else
  git diff --name-only --diff-filter=U | sed 's/^/SYNC_CONFLICT_FILE:/'
  git merge --abort
  echo SYNC_SKIPPED_CONFLICT
fi`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { CLONE_URL: target.cloneUrl, REMOTE_URL: target.remoteUrl },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  if (stdout.includes("SYNC_UP_TO_DATE")) return { status: "up_to_date" };
  if (stdout.includes("SYNC_SKIPPED_DIRTY")) return { status: "skipped_dirty" };
  const okMatch = /SYNC_OK:(\d+)/.exec(stdout);
  if (okMatch) return { status: "synced", commitsMerged: Number(okMatch[1]) };
  if (stdout.includes("SYNC_SKIPPED_CONFLICT")) {
    const conflictingFiles = stdout
      .split("\n")
      .filter((line) => line.startsWith("SYNC_CONFLICT_FILE:"))
      .map((line) => line.slice("SYNC_CONFLICT_FILE:".length).trim());
    return { status: "skipped_conflict", conflictingFiles };
  }
  // SYNC_SKIPPED_FETCH_FAILED, or any unrecognized output — fail soft, never throw. A sync is a
  // nice-to-have layered on top of a run that would otherwise proceed unchanged; a transient
  // network hiccup here should never be the reason a run fails.
  return { status: "skipped_fetch_failed" };
}

// Commits and pushes only if the agent actually changed something — a read-only turn (e.g. "what
// does this file do?") leaves /workspace clean, and there's nothing to push or open a PR for.
// Returns whether anything was pushed. This only ever runs *after* the agent's turn has already
// finished (called from worker.ts, not from anything the agent invokes), so it mints its own
// fresh token via the resolved provider's mintPushToken rather than relying on anything left
// over from cloneIntoSandbox — which no longer leaves a usable credential behind anyway (see
// that function's comment). The token is attached to the remote only for the duration of the
// push itself and stripped again immediately afterward, unconditionally (even on push failure),
// so a later turn in the same session never finds a working credential sitting in .git/config
// either.
//
// The credentialed push URL below stays GitHub-shaped (x-access-token:$TOKEN@github.com/...) —
// unlike cloneIntoSandbox/syncWithDefaultBranch's plain $REMOTE_URL, this one embeds a live
// credential, and a second provider's credential-URL scheme is explicitly out of scope for this
// migration (design spec §Out of scope: "Implementing a second provider").
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
  // Set only when this run actually pushed commits. Set whenever the agent ended its turn
  // checked out on a branch other than target.branch (it has full unrestricted bash access —
  // nothing stops it running `git checkout -b`). When set, `agentBranch` is whatever branch it
  // was actually on. If that branch was a descendant of target.branch, the script fast-forwards
  // target.branch onto it before continuing (see the BRANCH_MISMATCH marker below) and `pushed`
  // reflects the recovered push; otherwise nothing is touched and `pushed` stays false — the
  // caller (worker.ts) surfaces either outcome as an event so it's never silently lost like it
  // was for T-047.
  branchMismatch?: { agentBranch: string };
}

export async function pushChangesIfDirty(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
  commitMessage: string,
  authorName: string,
): Promise<PushResult> {
  const provider = getScmProvider(target.provider);
  if (!provider) throw new Error(`No registered SCM provider for "${target.provider}"`);
  const token = await provider.mintPushToken(target);

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
# above) — not just a dirty working tree, which is all the old check looked at. This first look
# uses whatever remote-tracking ref the sandbox already has cached, purely as a cheap no-op
# guard — it's refined below, once we know there's actually something to send, since a warm
# sandbox's cached ref for $BRANCH_NAME can be stale (see below).
STALE_BASE=$(git rev-parse --verify "origin/$BRANCH_NAME" 2>/dev/null || git rev-parse --verify origin/HEAD 2>/dev/null)
STALE_AHEAD=""
if [ -n "$STALE_BASE" ]; then
  STALE_AHEAD=$(git rev-list "$STALE_BASE..HEAD" 2>/dev/null)
fi

if [ -z "$(git status --porcelain)" ] && [ -z "$STALE_AHEAD" ]; then
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

  git remote set-url origin "https://x-access-token:$PUSH_TOKEN@github.com/$REPO_FULL_NAME.git"

  # Refresh our knowledge of $BRANCH_NAME's remote tip before pushing. Unlike the default branch
  # (kept warm by syncWithDefaultBranch on every run), nothing re-fetches $BRANCH_NAME itself once
  # the sandbox is cloned — so if an earlier run in this same warm session already pushed to it,
  # the cached origin/$BRANCH_NAME ref above is stale, and a plain push against a stale base is
  # exactly what git correctly rejects as non-fast-forward. Merge, never rebase, so the push below
  # stays a fast-forward instead of rewriting history the remote already has.
  git fetch origin "$BRANCH_NAME" --quiet
  MERGE_CONFLICT=0
  if git rev-parse --verify "origin/$BRANCH_NAME" >/dev/null 2>&1 && ! git merge-base --is-ancestor "origin/$BRANCH_NAME" HEAD 2>/dev/null; then
    if git merge --no-edit "origin/$BRANCH_NAME" >/dev/null 2>&1; then
      echo MERGE_OK
    else
      git diff --name-only --diff-filter=U | sed 's/^/CONFLICT_FILE:/'
      git merge --abort
      MERGE_CONFLICT=1
    fi
  fi

  # A real conflict against the remote tip means this branch name now has two divergent,
  # unrelated histories on it (most often: the branch name was reused — e.g. after a dev DB
  # reset regenerated a session id that a stale remote branch from a *different* session already
  # holds). A plain push here is not a recoverable "stale ref" case like the merge above handles
  # — it would just fail as the same opaque non-fast-forward rejection this whole re-fetch step
  # exists to avoid, so bail out now with a specific, actionable marker instead of attempting it.
  if [ "$MERGE_CONFLICT" -eq 1 ]; then
    git remote set-url origin "https://github.com/$REPO_FULL_NAME.git"
    echo PUSH_CONFLICT
  else
    # Both ends of what this run is adding. BASE_SHA is the branch as the remote knew it before
    # this push (or the default branch, for the session's first run) — re-read fresh above rather
    # than reused from STALE_BASE, since that fetch may have moved it. HEAD_SHA is where it lands
    # after committing (and merging in any remote-only commits just fetched). Emitted here rather
    # than derived later because the branch keeps moving: once the next run pushes, nothing on the
    # branch can say which commits were this run's.
    UPSTREAM_BASE=$(git rev-parse --verify "origin/$BRANCH_NAME" 2>/dev/null || git rev-parse --verify origin/HEAD 2>/dev/null)
    if [ -n "$UPSTREAM_BASE" ]; then echo "BASE_SHA:$UPSTREAM_BASE"; fi
    echo "HEAD_SHA:$(git rev-parse HEAD)"
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
  fi
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
  if (stdout.includes("PUSH_CONFLICT")) {
    const conflictingFiles = stdout
      .split("\n")
      .filter((line) => line.startsWith("CONFLICT_FILE:"))
      .map((line) => line.slice("CONFLICT_FILE:".length).trim())
      .filter(Boolean);
    throw new Error(
      `Cannot push: remote branch "${target.branch}" already has unrelated commits that conflict with ` +
        `this session's changes${conflictingFiles.length > 0 ? ` (in ${conflictingFiles.join(", ")})` : ""}. ` +
        `This usually means the branch name was reused by a different session — a plain push cannot resolve it.`,
    );
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
