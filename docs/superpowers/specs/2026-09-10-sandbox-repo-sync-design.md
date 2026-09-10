# Automatic repo sync for warm sandboxes — design spec

**Date:** 2026-09-10
**Status:** approved

## Problem

A session's sandbox is cloned once and reused across every subsequent run (`ensureSandbox`, `apps/worker/src/worker.ts:75-85`). `cloneIntoSandbox`'s "already cloned" path is a pure no-op beyond a remote-identity check — it never fetches, never checks whether `origin`'s default branch has moved (`apps/worker/src/scm-provider.ts:235-240`). So a task's checkout silently drifts behind `main` for as long as its session stays warm, with no path back to current.

This surfaced concretely with T-072: its session was started before T-071 (touching the same repo) was merged, and the agent itself cannot self-serve a fetch — `cloneIntoSandbox` deliberately strips the installation token from `origin` right after cloning, and the sandbox image ships no `gh`/`curl`/`wget` (`apps/worker/src/scm-provider.ts:202-212`; stated directly to the agent by `formatEnvironmentForPrompt`, `apps/worker/src/prompt-composition.ts:56-60`). That's correct and intentional — the agent must never hold live GitHub credentials — but it means nothing brings a stale checkout current except tearing the whole sandbox down and re-cloning, which today only happens via task-done/task-deleted/idle-reap, none of which fit "still in progress, just needs an updated base."

Explicit task dependency tracking (a `dependsOn` graph) was considered and explicitly rejected: the fix should not require anyone to declare which tasks depend on which. The real, more general problem is that *any* long-warm sandbox can go stale relative to `main`, regardless of why `main` moved.

## Goal

Before each run starts, transparently bring the checkout up to date with `origin`'s default branch whenever it's safe to do so — no dependency declarations, no blocking, no LLM involvement, and never at the cost of losing or corrupting anything already in the checkout.

## Ground truth this design relies on

- **`cloneIntoSandbox`'s already-cloned path does nothing beyond a remote check.** `apps/worker/src/scm-provider.ts:235-240` — `ALREADY_CLONED` is echoed and the function returns; no fetch happens.
- **The installation token is deliberately stripped from `origin` right after cloning**, and re-added only for the instant of a push (`apps/worker/src/scm-provider.ts:206-212`, `:349-358`). The agent never has a working remote credential — confirmed live: an agent asked to `git fetch` in-session correctly reported it has no network path to GitHub, matching `formatEnvironmentForPrompt`'s explicit line to that effect (`apps/worker/src/prompt-composition.ts:56-60`).
- **`resolveCloneTarget` already mints a fresh installation token every single run**, unconditionally, before `cloneIntoSandbox` is even called (`apps/worker/src/worker.ts:144`), and returns it embedded in `CloneTarget.cloneUrl`. Any new step that needs to authenticate to GitHub can reuse this same token — no new API calls required.
- **`pushChangesIfDirty` pushes with a plain, non-force `git push -u origin "$BRANCH_NAME"`** (`apps/worker/src/scm-provider.ts:356`). Any change to the checkout's history made before that push must keep the branch's existing tip as an ancestor of the new HEAD, or the next push breaks. A merge satisfies this; a rebase does not.
- **The clone/push scripts already use the "echo a sentinel, not a real exit code" pattern** across the sandbox-exec boundary (`SandboxProvider.exec` has no exit-code channel) — e.g. `CLONE_OK`/`ALREADY_CLONED`/`REPO_MISMATCH`, `NO_CHANGES`/`PUSH_OK`/`BRANCH_MISMATCH:<branch>`. The new step follows the same convention.
- **`formatEnvironmentForPrompt`/`SandboxEnvironment`** (`apps/worker/src/prompt-composition.ts:17-28`, `:34-108`) is the existing, tested mechanism for telling the agent platform-authored facts about its environment (checkout path, branch, issue context, attached documents) — this is the natural, already-idiomatic place to tell it about a sync, rather than an ad hoc string built in `worker.ts`.
- **`RunEvent` (`packages/core/src/events.ts:1-88`) is a closed, append-only union**, each variant a plain data shape with no shared "details" bag — precedent for adding a new type: `PolicyDecisionEvent`, `ModelEscalatedEvent`.
- **A plain `git clone <url>` (no `--branch`/`--single-branch`) sets `refs/remotes/origin/HEAD` as a symbolic ref to the remote's default branch automatically** — this is what lets the sync script compare against `origin/HEAD` directly rather than needing a separate GitHub API call to look up the default branch name (as `resolveDefaultBranchSha`/`openDraftPullRequest` already do for other reasons, `apps/worker/src/scm-provider.ts:149-160`, `:437-450`).
- **Existing tests for `scm-provider.ts` use a `fakeSandbox` fixture** (`apps/worker/src/__tests__/scm-provider.test.ts:37-70`) that returns canned stdout sentinel lines with no real git/network involved, and a `capturingSandbox` variant that records the script/env passed to `exec` for assertions on *what* was run.

## Scope

- `apps/worker/src/scm-provider.ts` — new `syncWithDefaultBranch(sandboxProvider, sandboxId, target): Promise<RepoSyncResult>`, called by `worker.ts` right after `cloneIntoSandbox` succeeds, every run.
- `packages/core/src/events.ts` — new `RepoSyncEvent` added to the `RunEvent` union.
- `apps/worker/src/prompt-composition.ts` — `SandboxEnvironment` gains an optional `repoSync` field; `formatEnvironmentForPrompt` gains a line for it.
- `apps/worker/src/worker.ts` — calls `syncWithDefaultBranch`, emits `repo_sync` when applicable, feeds the result into `SandboxEnvironment`.
- Tests: `apps/worker/src/__tests__/scm-provider.test.ts`, `apps/worker/src/__tests__/prompt-composition.test.ts`.

## Out of scope

- **Task dependency tracking of any kind.** Explicitly rejected — this design fixes staleness generally, not by knowing which task depends on which.
- **Stashing dirty work to force a sync through.** Considered and rejected: `git stash pop` has no clean abort equivalent to `git merge --abort`, and a dirty tree at this point in the pipeline is already an anomaly (a crashed prior run), not something worth engineering around. It self-heals once the tree is clean on a later run.
- **Rebasing onto `origin`'s default branch.** Rejected — it would rewrite the branch's history and break the next plain, non-force push.
- **The agent attempting to resolve sync conflicts itself.** It's told about a conflict, not instructed to fix it. What it does with that information (mention it, attempt a fix, ignore it) is its own call, same as any other environment fact it's handed.
- **A persistent task-level "stale" indicator in the UI.** Considered; decided that a transcript event plus an agent-facing note (which the agent can relay in its own reply) is enough for now — no schema/UI change.
- **A configurable opt-out or sync toggle.** Always-on, consistent with how other fixed constants in this codebase (`MEMORY_BASE_MB`, `SANDBOX_IDLE_THRESHOLD_MS`) start as constants until a real need for configurability shows up.

## Design decisions

- **A new function, not a branch inside `cloneIntoSandbox`.** `syncWithDefaultBranch` is a separate exec call, mirroring the existing separation between `cloneIntoSandbox` and `pushChangesIfDirty` — each script stays focused on one concern and stays independently testable via `fakeSandbox`. Called unconditionally after every successful `cloneIntoSandbox`, including right after a true first-time clone — on a fresh clone there's nothing to sync (HEAD already is `origin/HEAD`), so it's a correct, cheap no-op there.
- **Reuses `target.cloneUrl`'s already-embedded token rather than minting a new one.** The script temporarily points `origin` at `target.cloneUrl` (credentialed), fetches, then immediately points it back at the plain `https://github.com/$REPO_FULL_NAME.git` URL — same inject-use-strip pattern `pushChangesIfDirty` already uses for the identical reason (never leave a usable credential sitting in the sandbox for the agent to find).
- **Merge, never rebase**, to keep the next push a fast-forward (see Ground truth).
- **Clean-tree precondition, no stashing.** If `git status --porcelain` is non-empty, skip entirely — silent, no event, no agent note. This case should be rare (a prior run crashing before its own push step) and self-heals next run once the tree is clean.
- **A failed merge aborts cleanly and changes nothing.** `git merge --abort` restores the exact pre-attempt state; the run proceeds on the old base, same as today.
- **Visibility is a transcript event plus an agent-facing environment note — for `synced` and `skipped_conflict`, not for `skipped_dirty` or the "nothing changed" no-op.** Dirty is silent because it self-heals; up-to-date is silent because there's nothing to say. `synced` gets a note so the agent understands why code around it may look different from its last turn. `skipped_conflict` gets a note because, unlike dirty, it does **not** self-heal — the same conflict recurs on every future run until someone actually resolves it, so the agent (and, through it, you) needs to keep hearing about it rather than it silently going stale forever.
- **No new GitHub API calls.** The only network cost is the `git fetch` itself, which is a cheap ref-advertisement round trip when nothing changed and a normal `git pull`-sized cost on the rare run where something did.

## Mechanism

### Sync script (`syncWithDefaultBranch`)

```ts
// apps/worker/src/scm-provider.ts
export interface RepoSyncResult {
  status: "up_to_date" | "synced" | "skipped_dirty" | "skipped_conflict" | "skipped_fetch_failed";
  commitsMerged?: number; // present when status === "synced"
  conflictingFiles?: string[]; // present when status === "skipped_conflict"
}

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
git remote set-url origin "https://github.com/$REPO_FULL_NAME.git"
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
    env: { CLONE_URL: target.cloneUrl, REPO_FULL_NAME: target.repoFullName },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  if (stdout.includes("SYNC_SKIPPED_FETCH_FAILED")) return { status: "skipped_fetch_failed" };
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
  return { status: "skipped_fetch_failed" }; // unrecognized output — fail soft, never throw
}
```

`skipped_fetch_failed` is deliberately silent (no event, no agent note) — a transient network hiccup isn't worth surfacing every time; it'll just retry next run.

### Wiring into worker.ts

```ts
// apps/worker/src/worker.ts, right after cloneIntoSandbox(...)
const syncResult = await syncWithDefaultBranch(sandboxProvider, sandboxId, workspace);
mark(`repo sync (${syncResult.status})`);

if (syncResult.status === "synced" || syncResult.status === "skipped_conflict") {
  await createEvent(runId, seq++, "repo_sync", {
    status: syncResult.status,
    commitsMerged: syncResult.commitsMerged,
    conflictingFiles: syncResult.conflictingFiles,
  });
}
```

The `SandboxEnvironment` passed into `formatEnvironmentForPrompt` picks up a `repoSync` field built from the same `syncResult`, populated only for those same two statuses.

### New event type

```ts
// packages/core/src/events.ts
export interface RepoSyncEvent extends RunEventBase {
  type: "repo_sync";
  status: "synced" | "skipped_conflict";
  commitsMerged?: number;
  conflictingFiles?: string[];
}
```

Added to the `RunEvent` union alongside the existing variants.

### Prompt note

```ts
// apps/worker/src/prompt-composition.ts — SandboxEnvironment
export interface SandboxEnvironment {
  // ...existing fields
  repoSync?:
    | { status: "synced"; commitsMerged: number }
    | { status: "skipped_conflict"; conflictingFiles: string[] };
}
```

```ts
// formatEnvironmentForPrompt — appended after the existing lines, only when env.repoSync is set
if (env.repoSync?.status === "synced") {
  lines.push(
    `- This task's checkout was just synced with ${env.repoSync.commitsMerged} new commit` +
      `${env.repoSync.commitsMerged === 1 ? "" : "s"} from the default branch before this turn began. ` +
      "Code you remember from an earlier turn in this session may have changed.",
  );
}
if (env.repoSync?.status === "skipped_conflict") {
  lines.push(
    "- The default branch has moved on since this checkout was created, but syncing it in failed " +
      `due to conflicts in: ${env.repoSync.conflictingFiles.join(", ")}. This will keep failing on ` +
      "every future turn until it's resolved — mention this, or resolve it yourself if it's relevant " +
      "to what you're doing.",
  );
}
```

## Testing

- **`syncWithDefaultBranch` unit tests** (`scm-provider.test.ts`, `fakeSandbox` pattern): one case per sentinel — up to date, synced with a commit count, skipped dirty, skipped conflict with a file list, skipped fetch failure, and an unrecognized/garbled output falling back to `skipped_fetch_failed` rather than throwing.
- **Token handling test**: asserts the script receives `target.cloneUrl` (not a freshly minted token) via env vars, matching the existing "token never appears in argv" test style used for clone/push.
- **`formatEnvironmentForPrompt` tests** (`prompt-composition.test.ts`): asserts the synced line appears only when `repoSync.status === "synced"`, the conflict line only for `skipped_conflict`, singular/plural commit wording, and that neither line appears when `repoSync` is undefined.

## Risks

- **A clean merge can still break the build without git flagging a conflict** (e.g. a renamed function the agent's own code still calls). The agent isn't warned beyond "N commits were merged" — it has to notice by reading/running the code, same as a human would after `git pull`. Not something this design can detect ahead of time.
- **`skipped_conflict` recurs every run until resolved**, which means the agent-facing note repeats every turn too. Accepted as correct — it's true every time until someone actually fixes it — but worth watching in practice for whether it becomes noisy enough to warrant the task-level indicator this design chose to skip.
- **A very large divergence could produce a long `conflictingFiles` list** with no truncation. Left unbounded for now (YAGNI) — can add a cap later if a real case shows it's a problem.
