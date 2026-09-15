# PR review agents post comments to GitHub — design

> Scopes [#213](https://github.com/or-borco/AgentFactory/issues/213). This is a design/spec
> document; implementation follows in a separate plan/PR.

## Problem

A team can already have a Code review agent. A user creates a task like "Review PR #42",
assigns it to that agent, and runs it — but the review only ever shows up in the run transcript.
It never reaches GitHub, so nobody sees it where PR review actually happens.

## Goal

When a task whose description contains a GitHub PR link is run by any agent, the run behaves as
a *review*: it reads the PR in a sandbox, produces a structured review, and the worker posts it
to GitHub as a real review with inline comments anchored to files/lines — then marks the task
done with a link to the posted review.

## Decisions

- **Trigger: manual.** The user creates and runs the task, exactly as today. No GitHub webhooks,
  no polling, no automatic trigger from a Developer agent's own PRs. This is a deliberate
  narrowing of issue #213's "triggered against a PR… re-review automatically when new commits are
  pushed" language — re-review here is a one-message action (see below), not automatic. Flagging
  this for Or to confirm is in scope; building the trigger bus (`triggers` table, webhook
  receiver — ARCHITECTURE.md §2.6/§5, M5) is not.
- **Detection: a PR link in the task, not an agent role.** No new "reviewer" role on `Agent`, no
  new task-kind field, no persisted field on `Task` either. The worker parses `task.description`
  for a GitHub PR URL live, at the start of every run — the same mechanism
  `parseIssueReference`/`worker.ts:228` already uses for GitHub *issue* links, just a sibling
  regex for `/pull/` instead of `/issues/`. `RegExp.exec` naturally returns the first match, so
  "the first PR link in the description wins" falls out of reusing that mechanism rather than
  needing its own rule. The existing agent picker on the task form is unchanged — the user still
  chooses which agent runs the task.
- **What the agent sees:** the full repo checked out at the PR's head, not just the diff — so it
  can follow imports, check callers, read surrounding code.
- **How comments reach GitHub:** the agent never holds a GitHub token. It ends its turn with a
  structured (JSON) review; the worker validates it against the real diff and posts one GitHub
  review afterward — the same "host writes to GitHub after the turn" shape as
  `openDraftPullRequest` today.
- **Verdict:** `comment` or `request_changes`, the agent's choice. Never `approve` — an agent
  approving is the one thing ARCHITECTURE.md §6's blast-radius table rules out categorically,
  since it's a step toward a bot merging into a protected branch on its own.
- **Re-review:** a follow-up message on the same task is a new run in the same session (already
  how follow-ups work). The run always happens; only *posting to GitHub* is conditional on the
  agent having something new to say.
- **Large PRs:** always reviewed, with an explicit, visible caveat about coverage rather than a
  silent best-effort. See "Large diffs" below.

### Out of scope

Automatic/webhook triggers, polling, auto-fix loops (agent re-runs the Developer on review
feedback), `approve` verdicts, a merge-blocking check run, a dedicated "PR to review" form field,
a Reviews dashboard, reviewing PRs on repos without a connected GitHub App.

## Data model

No new field on `Task`. `parsePullRequestReference(description)` (new sibling to
`parseIssueReference` — see `packages/scm` additions below) is what tells the worker a run is a
review, computed fresh each run; nothing about "this task is a review" is persisted ahead of
time. The only new persistence is the record of reviews actually posted:

### `pr_reviews` (new table)

One row per review pass actually posted to GitHub.

| column | type | purpose |
|---|---|---|
| `id` | identity PK | |
| `org_id` | fk `orgs.id` | tenant scope |
| `task_id` | fk `tasks.id` | which task |
| `run_id` | fk `runs.id` | links to the transcript that produced it |
| `repo_full_name` | text | which repo — the display source for the task page, since there's no persisted task field to read it from |
| `pr_number` | integer | which PR |
| `base_sha` | text | base of the range this pass reviewed |
| `head_sha` | text | head of the range — the next pass's starting point |
| `verdict` | `"comment" \| "request_changes"` | what the agent decided |
| `posted_as` | `"comment" \| "request_changes"` | what GitHub actually accepted (differs when the own-PR fallback fires) |
| `github_review_id` | text | GitHub's review id |
| `url` | text | link to the review on GitHub |
| `comment_count` | integer | inline comments that passed validation |
| `truncated` | boolean, default false | whether the diff handed to the agent was capped |
| `created_at` | timestamptz | |

Index on `(task_id, created_at desc)` — both "latest review for task X" (task page) and "last
reviewed head_sha for task X" (next re-review) are single indexed lookups against this table,
kept off the hot `runs` row the task page polls every 1.5s (same reasoning as `run_evals` and
`run_context_retrievals`).

### `packages/core` additions

- `ArtifactEvent.artifactType` and `Artifact.type` gain `"review"`.

### `packages/scm` (`ScmProvider` port) additions

New methods, implemented by `githubScmProvider`:

```ts
fetchPullRequest(connection: Connection, repoFullName: string, prNumber: number): Promise<{
  state: "open" | "closed" | "merged";
  baseBranch: string;
  headSha: string;
  title: string;
  body: string;
}>;

checkoutPullRequest(sandboxProvider, sandboxId, connection, target: CloneTarget, prNumber: number): Promise<void>;

fetchReviewThreads(connection: Connection, repoFullName: string, prNumber: number): Promise<ReviewThread[]>;

postReview(connection: Connection, repoFullName: string, prNumber: number, review: {
  summary: string;
  verdict: "comment" | "request_changes";
  comments: Array<{ path: string; line: number; body: string }>;
}): Promise<{ id: string; url: string; postedAs: "comment" | "request_changes" }>;

// Sibling to parseIssueReference — same shape, matches a /pull/ URL instead of /issues/.
parsePullRequestReference(text: string): { repoFullName: string; prNumber: number } | undefined;
```

`parsePullRequestReference` is exposed the same way `parseIssueReference` is today: a
per-provider method on `ScmProvider`, dispatched across all registered providers by a new
`parsePullRequestReferenceAcrossProviders` in `packages/scm/src/registry.ts` (mirrors
`parseIssueReferenceAcrossProviders`). `postReview` is the one that implements the own-PR
fallback (see below) — callers don't detect it themselves.

## The review run, step by step

Applies when `parsePullRequestReference(task.description)` returns a match. Branches off the
existing worker pipeline at the point where it resolves the workspace, and rejoins at prompt
composition.

1. **Resolve the PR.** `fetchPullRequest`. If `state !== "open"`, fail the run immediately with
   "PR #N is already merged/closed" — never review dead code. If the org's GitHub connection
   can't see the repo, fail with the same message the codebase already uses for that case in
   `resolveCloneTarget`.

2. **Workspace.** Same sandbox as today (`ensureSandbox`). `resolveCloneTarget` resolves repo
   access via the org's GitHub connection (the parsed `repoFullName`, not `task.codebase` — that
   field is ignored for review runs), and the repo is cloned in if not already present, exactly
   as `cloneIntoSandbox` does today — except it does *not* create or check out an
   `agent/session-*` branch, since a review run never commits or pushes. On top of that,
   `checkoutPullRequest` fetches GitHub's `refs/pull/N/head` (works for same-repo and fork PRs
   alike) into a local `review/pr-N` branch, force-checked-out on *every* pass — so a warm
   sandbox always lands on the current head, discarding whatever a prior pass's exploration left
   behind. No default-branch sync, no push step.

3. **Range to review.**
   - First pass: `baseBranch` → `headSha`.
   - Later passes: look up the most recent `pr_reviews` row for this task. If its `head_sha` is
     an ancestor of the current `headSha` (`git merge-base --is-ancestor`), the range is
     `last head_sha` → current `headSha`. If not (force-push rewrote history, or the check
     fails), fall back to a full `baseBranch` → `headSha` range and tell the agent in its prompt
     that the branch was rewritten so its prior comments may no longer apply cleanly.
   - If the current `headSha` equals the last reviewed `head_sha` (no new commits), the range is
     empty — the run still happens (see step 4), it just has nothing new to highlight.

4. **Context for the prompt.** Worker-composed and injected host-side, same pattern as issue-text
   injection today: PR title/body, the diff for the range (capped — see "Large diffs" below),
   and on any pass after the first, the PR's existing review threads via `fetchReviewThreads`
   (the agent's own prior comments plus any human replies), so it doesn't repeat itself. The
   review agent's own configured system prompt is untouched; the worker adds a short environment
   segment: "You are reviewing PR #N (range X..Y). Respond only in the structured format below."
   The triggering message (a follow-up like "also check the tests") is passed through normally.

5. **The turn.** `runAgentTurn` as today, plus `outputFormat: { type: "json_schema", schema }`
   on the SDK query, where the schema is:
   ```ts
   { summary: string, verdict: "comment" | "request_changes", comments: Array<{ path: string, line: number, body: string }> }
   ```
   Tool access inside the sandbox is unrestricted, as everywhere else today — the run is
   read-only by construction, because there is no push step and no GitHub token ever enters the
   sandbox.

6. **Validate.** Every `{path, line}` is checked against the PR's *full* base→head diff (not
   just this pass's range — GitHub anchors comments to the full diff at head, so a remark about a
   line changed in an earlier pass is still a valid anchor), and only against added/context lines
   on the new side (v1 does not support anchoring to deleted lines). Anything that doesn't
   validate is folded into the summary as `path:line — body` instead of silently dropped.

7. **Post.** `postReview` with the summary, validated inline comments, and verdict.
   - `verdict: "comment"` → posts a `COMMENT` review.
   - `verdict: "request_changes"` → attempts `REQUEST_CHANGES`. On GitHub's specific "can not
     request changes on your own pull request" 422 (the case where the reviewing App also opened
     the PR), reposts as `COMMENT` with the summary prefixed `⛔ Changes requested`. `postedAs`
     records which actually happened.
   - If there are zero validated comments *and* the range was empty (step 3's no-new-commits
     case), skip posting entirely — the agent's answer still lands in the transcript as the
     assistant message, but nothing new goes to GitHub. This is what stops a re-run from posting
     a duplicate summary.

8. **Record and finish.** Insert the `pr_reviews` row. Render the structured output as readable
   markdown (summary + bullet list of file:line comments) for the stored assistant message —
   never raw JSON in the transcript. Emit an `artifact` event (`type: "review"`, `url` to the
   GitHub review) when a review was posted. Set `task.status = "done"`.

### Large diffs

The diff handed to the agent is capped at 120,000 characters — the same `MAX_ARTEFACT_CHARS`
constant and truncate-with-marker pattern `eval-judge.ts` already uses for the same kind of text.
Past the cap:

- The run is **not** failed. It proceeds with the truncated diff.
- The agent's prompt says the diff was truncated and tells it to run `git diff` itself in the
  sandbox for the rest — it has full tool access to do so, but doing so isn't enforced or
  guaranteed.
- `pr_reviews.truncated` is set `true`, and the task page shows this as an explicit caveat next
  to the verdict — *"This PR is very large — review coverage may be partial"* — not a quiet
  technical flag. This is a known limitation, stated plainly, not a solved problem.

### Failure handling

Unlike the Jira write-back (fail-soft, a courtesy), the review **is** the deliverable of this run
— step 1 or step 7 failing fails the whole run, with the reason in the event log, exactly like
any other run failure today. `task.status` goes to `failed`, same as the existing catch-all in
`worker.ts`.

## Task page

A new "Review" block, populated from the latest `pr_reviews` row for the task:

- Verdict (`Comment` / `Changes requested`) and `posted_as` if it differs from `verdict` (i.e.
  the own-PR fallback fired) — shown plainly, e.g. "Requested changes (posted as a comment — PR
  opened by this app)".
- Comment count.
- Link to the review on GitHub.
- The large-diff caveat, when `truncated` is true.

## What this does not change

- No `triggers` table, no webhook receiver, no policy engine, no `ToolPolicy` enforcement.
- No new agent field, no new task-kind/type column, no new field on `Task` at all.
- `Session`/`Run` shapes are unchanged; a review run is an ordinary run whose task's description
  happens to parse as a PR link.
