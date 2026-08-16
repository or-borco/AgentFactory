# Sandbox branch-mismatch recovery — design spec

**Date:** 2026-08-16
**Status:** approved

## Problem

`apps/worker/src/worker.ts` provisions one fixed branch per session (`agent/session-<id>`, set in `resolveCloneTarget`) and, after the agent's turn ends, calls `pushChangesIfDirty` to commit/push whatever is dirty in `/workspace` and open a draft PR. That function only ever checks `git status --porcelain` on the branch it assumes is still checked out.

The agent has full unrestricted bash access inside the sandbox (per `CLAUDE.md`'s "no approval gates" policy) and is free to run any git command, including `git checkout -b <other-name>`. If it does — and then commits its own work there instead of leaving edits for the host to commit — the working tree on `agent/session-<id>` stays clean. `pushChangesIfDirty` sees `NO_CHANGES`, silently returns `pushed: false`, and the task sits stuck at `in_progress` forever with no PR, no error, and no visible signal anywhere in the transcript.

This was found on a real task (T-047): the agent committed a real fix (`11e0479`, 6 files) to `fix/53-surface-real-run-error` instead of `agent/session-5`, then correctly reported it had no GitHub push credentials — not realizing the host was supposed to push on its behalf and had already silently failed to.

The same root cause — `pushChangesIfDirty` only detecting *uncommitted* changes — also under-detects a narrower case with no branch switch at all: an agent that commits its own work directly on the correct branch, bypassing the host's commit step.

## Goal

Make `pushChangesIfDirty` robust to whatever the agent actually left in `/workspace`, without constraining what the agent is allowed to do to git. Recover automatically when it's safe to, and leave a visible trace either way.

## Scope

- `apps/worker/src/scm-provider.ts`: `pushChangesIfDirty` — branch normalization + refined dirty-check.
- `apps/worker/src/worker.ts`: emit an `error` event when normalization occurs.
- No frontend changes — reuses the existing `error` event type and `ErrorNotice` component verbatim.
- No new DB columns, no new `RunEvent` variant.

## Out of scope (deferred)

- The pre-existing gap where `openDraftPullRequest` is called unconditionally whenever `pushed: true`, with no check for an already-open PR on that branch (would 422 on a second push within the same session against an existing PR). Predates this change; the refined dirty-check here makes repeated-push turns marginally more likely to hit it than today's under-triggering check, but doesn't introduce the gap. Worth its own fix, separately.
- Manually recovering T-047's specific stuck commit — an operational action, not part of this spec.
- Any system-prompt guidance steering the agent's git behavior — deliberately not pursued; see "Fix direction" decision below.

## Design decisions

- **Host-side robustness, not agent constraints.** The agent's unrestricted tool access is unchanged. The fix makes the host detect and adopt whatever the agent produced, rather than relying on the agent staying on an assigned branch.
- **Normalize to the canonical branch name.** The PR head branch stays `agent/session-<id>` across every run in a session, regardless of what the agent named things mid-turn — so a later turn's push keeps updating the same PR rather than depending on a branch name that could change turn to turn.

## Mechanism

### 1. Branch normalization (fast-forward only)

At the start of the push script, before the existing dirty-check:

1. Read the checked-out branch: `git branch --show-current` (empty string if detached HEAD).
2. If it already equals the target (`agent/session-<id>`), skip to step 2 below unchanged — this is the happy path, zero behavior change.
3. If it differs, check whether the target branch is an ancestor of current HEAD: `git merge-base --is-ancestor <target> HEAD`.
   - **Ancestor (safe to fast-forward):** move the target branch's ref to HEAD — `git branch -f <target> HEAD` — and check it out. This is T-047's case: the agent's stray branch is target-plus-commits, so fast-forwarding loses nothing.
   - **Not an ancestor (diverged or unrelated):** do not touch the target branch. Check it out as-is. Whatever the agent left elsewhere is untouched in the container's filesystem — recoverable later, just not this turn.
4. Regardless of which branch it took, end the script checked out on the target branch, so the *next* turn in the session starts from the canonical branch rather than wherever the agent wandered off to.

This is a hard safety property: **normalization only ever fast-forwards.** It cannot rewrite or discard history, and a non-fast-forward `git push` (no `--force` is ever used) already fails safely on its own if the remote has diverged.

### 2. Refined "is there anything to push" check

Today: `git status --porcelain` non-empty. This misses already-committed work.

New: uncommitted changes present, **or** HEAD has commits not yet on the remote. For the latter, diff against `origin/<target-branch>` if it exists (a prior turn already pushed this branch), else against `origin/HEAD` (the default branch's remote-tracking ref, set automatically by `git clone`, no extra host-side lookup needed) as the "since this session's clone" baseline.

This also fixes the narrower same-branch case from the Problem section (agent self-commits without switching branches) — the existing behavior only ever looked at `git status --porcelain`, which is empty the moment something is committed, switch or no switch.

### 3. Return contract

```ts
export interface PushResult {
  pushed: boolean;
  changedFiles: string[];
  branchMismatch?: { agentBranch: string }; // set whenever normalization ran, fast-forwarded or not
}
```

### 4. Event emission

`scm-provider.ts` stays event-agnostic (matches its existing shape — it returns data, `worker.ts` is the only `createEvent` call site). When `pushChangesIfDirty` returns `branchMismatch`:

```ts
await createEvent(runId, seq++, "error", {
  message: `Agent committed to branch "${result.branchMismatch.agentBranch}" instead of the assigned "${workspace.branch}" — ${
    result.pushed
      ? "recovered automatically and pushed from there."
      : "left uncommitted; nothing was pushed this turn."
  }`,
});
```

Reuses the `error` `RunEvent` type and the existing `ErrorNotice` component in `page.tsx` (already used for the GitHub-issue-fetch failure) — renders as the same amber non-fatal-notice banner above the agent's reply. No frontend changes required.

## Edge cases

- **Multiple stray branches:** only the branch checked out at end-of-turn (HEAD) is considered. If the agent created several branches and ended the turn on an unrelated one, nothing is recovered automatically — but nothing is destroyed either; the warm sandbox persists those commits for a future turn or manual recovery.
- **Detached HEAD:** treated the same as "current != target" — goes through the same ancestor check.
- **Second run, no new commits since a prior successful push:** the refined check correctly returns "nothing to push" (HEAD isn't ahead of `origin/<target-branch>`), same as today — this is the regression case the tests need to pin down explicitly, since it's what keeps the change from over-triggering.

## Testing

Unit tests in `apps/worker/src/__tests__/scm-provider.test.ts` (existing file), using its existing pattern of a fake `SandboxProvider.exec` returning canned stdout for the shell script's marker lines:

1. Happy path unchanged — uncommitted edits on the correct branch, host commits and pushes, no `branchMismatch`.
2. Agent committed on a descendant branch (T-047's case) — fast-forward, push succeeds, `branchMismatch` set, `pushed: true`.
3. Agent ended the turn on an unrelated/non-descendant branch — no fast-forward, `branchMismatch` set, `pushed: false`.
4. Second run, no new commits after a prior successful push — `pushed: false`, no `branchMismatch`, no event (regression guard).
5. Agent self-committed directly on the correct branch (no switch) — `pushed: true` via the refined remote-ahead check, no `branchMismatch`.

`worker.ts`'s new conditional `createEvent` call is small enough to cover via the existing job-processor path if there's an integration-style test for it already; otherwise it's straightforward enough not to need a dedicated unit test beyond the `scm-provider` coverage above, consistent with how `worker.ts`'s BullMQ wiring is treated elsewhere in the codebase.

## Implementation plan / PR split

Single PR — the whole change is one function's internals plus one new call site, ~2 files:

1. `apps/worker/src/scm-provider.ts` — normalization + refined dirty-check + `PushResult.branchMismatch`, plus the new `scm-provider.test.ts` cases.
2. `apps/worker/src/worker.ts` — emit the `error` event when `branchMismatch` is present.
