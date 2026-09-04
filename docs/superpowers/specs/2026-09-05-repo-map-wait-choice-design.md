# Repo map wait choice at task creation — design spec

**Date:** 2026-09-05
**Status:** draft

## Problem

[PR #156](https://github.com/or-borco/AgentFactory/pull/156) fixed two bugs from task T-070: `POST /api/tasks` didn't warm the repo-map cache when a codebase was set, and a cache miss in `ensureRepoMap` gave up instantly instead of ever looking again. The fix warms on task creation and polls the cache for up to `CACHE_POLL_TIMEOUT_MS` (20s) on a miss.

Reviewer feedback on that PR ([comment](https://github.com/or-borco/AgentFactory/pull/156#issuecomment-5540054191)) identified a gap the fix doesn't close: generation is measured at 33–38s, so in the "task created and run immediately" scenario, the 20s poll is bounded below the generation time. That run burns the full poll window and then proceeds without a map anyway — no better than doing nothing, plus 20 wasted seconds. A bigger timeout only shifts where this breaks; a poll can't fix a scenario where waiting doesn't fit inside the wait budget.

The deeper issue: today the system silently picks a tradeoff on the user's behalf — wait a fixed, guessed amount of time, or don't — without the user ever knowing a tradeoff was made. A user who created a task against a repo the system has never seen has no way to know that running it immediately means the agent will spend real time and token cost re-discovering the codebase by hand (the original T-070 trace: `git remote -v && git log && ls -la`, then six `Read` calls before writing a line).

## Goal

When a user creates a task against a codebase with no cached repo map for its current commit, tell them so in plain terms and let them choose: wait for the map to finish generating before the task is created, or create it immediately without one. Make this an explicit, informed choice at task-creation time — not a hidden constant, and not a pause inserted into a running agent.

This is additive to PR #156, not a replacement. Everything PR #156 built stays exactly as merged and continues to be what protects every other path: "start now" tasks, tasks against already-cached repos, and any run that reaches `ensureRepoMap` for a repo this new UI never saw (e.g. a run started from an existing session, not a fresh task).

## Ground truth this design relies on

- **Task creation and run-triggering are already two separate steps.** `POST /api/tasks` (`apps/web/src/app/api/tasks/route.ts`) only creates the row (status `"assigned"` or `"open"`, per `packages/db/src/repositories/tasks.ts:74`) — it never enqueues a run. A run only starts via `POST /api/tasks/[taskId]/run`, wired to the "Run" button on the task detail page (`apps/web/src/app/(app)/tasks/[taskId]/page.tsx`). T-070's 17-second gap between creation and run start is consistent with a user creating a task and immediately clicking Run, not any automatic trigger — there isn't one today (`Agent.mode` is read only by display code, never by anything that enqueues a run).
- **No approval-gate or paused-run concept exists anywhere**, by design (ARCHITECTURE.md: "no approval gates... runs are never paused waiting for human input"; "run state lives in Postgres, never in closures"). `TaskStatus` (`open | assigned | in_progress | needs_input | pr_open | review_cycle | done | failed | cancelled`) and `RunStatus` (`queued → provisioning → running → finalizing → done | failed | cancelled`) have no "waiting on a repo map" value, and this design does not add one.
- **`getRepoMap(orgId, repoFullName, commitSha)`** (`packages/db/src/repositories/repo-maps.ts`) is a plain DB read already importable from `apps/web` — no worker-only dependency.
- **`warmRepoMap` already checks the cache before provisioning a sandbox** (`apps/worker/src/repo-map.ts:144`, confirmed by reading the code): `if (await getRepoMap(orgId, repoFullName, sha)) return;`. Triggering a warm job for a repo+sha that's already cached is cheap — one DB read, no sandbox, no regeneration. This design relies on that existing guarantee rather than adding new dedup logic.
- **`enqueueRepoMapWarmJob(orgId, repoFullName)`** (`packages/queue/src/index.ts`) needs no task to exist — it's already called this way from agent and team routes when their `defaultCodebase` is set.
- **GitHub API access from `apps/web` already exists and follows an established duplication pattern.** `apps/web/src/server/github-app.ts` independently implements the same GitHub App JWT → installation-token flow as `apps/worker/src/scm-provider.ts`, with an explicit comment on the worker side explaining the duplication is deliberate ("apps/worker and apps/web are separate processes/packages with no shared-code path between them today, and this is ~20 lines"). `apps/web`'s own `/api/connections/github/repos` route already resolves an org's GitHub installation(s) via `listConnections` + `listInstallationRepos` to populate the task-creation codebase picker. Resolving a default-branch sha (mirroring the worker's `resolveDefaultBranchSha`, `scm-provider.ts:148-169`: `GET /repos/{full_name}` for `default_branch`, then `GET /repos/{full_name}/commits/{branch}` for `sha`) needs no new credential plumbing — just a small new function in `apps/web/src/server/github-app.ts` following the same pattern.
- **The codebase field in the task-creation form is a `<select>` populated from connected repos** (`apps/web/src/app/(app)/tasks/new/page.tsx`), not a free-text or autocomplete field — a mapped-status check fires once per selection, not per keystroke.

## Scope

- `apps/web/src/server/github-app.ts` — add a `findInstallationForRepo(orgId, repoFullName)` helper (mirroring the module-private one in `apps/worker/src/scm-provider.ts`, not currently exported so not reusable as-is) and `resolveDefaultBranchSha(orgId, repoFullName)` built on it, mirroring the worker's two-call GitHub API sequence.
- New route, `GET /api/repos/map-status?codebase=owner/repo` — resolves the sha via the function above, checks `getRepoMap(orgId, repoFullName, sha)`, returns `{ mapped: boolean }`. Fails open (see Design decisions) rather than surfacing an error to the caller.
- Same route (or a sibling action) accepts triggering the warm job — the frontend needs a way to call `enqueueRepoMapWarmJob(orgId, repoFullName)` before a task exists. Exact shape (a second query param / method on the same route vs. a separate endpoint) is an implementation-planning decision, not fixed here.
- `apps/web/src/app/(app)/tasks/new/page.tsx` — on codebase selection, call the map-status check; render the inline banner on a miss (see Mechanism); "Wait" triggers the warm job and polls map-status; escape hatch and "start now" both fall through to the existing, unchanged submit path.
- Tests for the new `resolveDefaultBranchSha` function and the new route, following the mocking convention already used in `apps/web/src/app/api/tasks/__tests__/route.test.ts` (added by PR #156).

## Out of scope

- **Any change to `Task`'s domain type, the DB schema, `TaskStatus`/`RunStatus`, `POST /api/tasks`, `POST /api/tasks/[taskId]/run`, the worker, or `ensureRepoMap`'s existing poll.** All of PR #156 stays exactly as merged; this design adds a new decision point before task creation, nothing more.
- **A configurable poll/wait timeout.** Considered and rejected — see Design decisions.
- **Blocking a run mid-execution, or any new "waiting" status on `Task` or `Run`.** Considered and rejected — see Design decisions.
- **New end-to-end test coverage.** PR #156 already documented the e2e suite as flaky in this environment for unrelated reasons; whether a new spec is worth adding is an implementation-planning decision, not committed to here.
- **The frontend component-testing approach** for the new banner/waiting-state UI — deferred to planning, pending confirming what convention (if any) already exists in `apps/web` for this kind of interaction test.
- **Pruning or deduplicating concurrent map-status polls from multiple browser tabs/users on the same repo.** Each poll is a cheap DB read (see Design decisions); not worth coordinating across sessions today.

## Design decisions

- **The choice happens before the task exists, not mid-run and not by gating the "Run" button.** Three mechanisms were considered:
  1. Block the `POST /api/tasks` request itself until the map is ready — rejected: ties up an HTTP request for 30+ seconds, and no other part of this system works that way (both the run pipeline and the existing warm job are queue-based/async).
  2. Create the task immediately, but gate the "Run" button/action on a stored per-task flag until the map lands — rejected: needs a new `Task` field, a new "waiting" concept with no existing `TaskStatus` value to represent it, and a task left sitting in a state that means nothing if the user simply never returns to click Run.
  3. **(Chosen)** Delay creating the task at all. The warm job only needs an org and a repo name, not a task, so it can be triggered from the creation form directly. The frontend polls a small status check and only calls `POST /api/tasks` once the map is ready, or once the user hits the escape hatch. If the user abandons the wait (closes the tab), nothing was ever created — no orphaned state, no cleanup, no schema change.
- **The choice is binary — wait or start now — with no configurable timeout.** A numeric knob (see the review comment on PR #156) just relocates the same problem: PR #156's own `CACHE_POLL_TIMEOUT_MS = 20_000` was already "a judgement call, not a measurement" from one data point, and a bigger constant is still a guess about how long every future repo will take to map. Making the number user-facing doesn't fix that it's a guess; it just asks the user to guess instead. Letting the user directly choose "wait until it's actually done" or "don't wait at all" sidesteps needing the number to be right.
- **No automatic timeout while waiting — the escape hatch is the only way out.** If generation is simply slow, this matches the "no configured number" reasoning above. If generation has failed outright (see Error handling), that's a distinct case: the UI detects it explicitly and offers the same fallback proactively, rather than making the user wait for a guessed cutoff.
- **Inline banner, not a modal dialog.** Chosen after comparing both directly as mockups: the banner keeps the rest of the form visible and fillable, where a modal interrupts and blocks it. Both convey the same information; the banner is less disruptive for a decision that isn't urgent.
- **No new idempotency work for triggering the warm job twice.** Choosing "wait" triggers `enqueueRepoMapWarmJob` before the task exists; if the task is then created, `POST /api/tasks`'s existing PR #156 logic triggers it again. This is safe as-is: `warmRepoMap` already checks the cache before provisioning a sandbox (`apps/worker/src/repo-map.ts:144`), so the second call is a cheap no-op, not a duplicated generation cost.
- **Every new piece fails open.** If the map-status check can't run at all (no GitHub connection, GitHub API error), skip the banner entirely and let task creation proceed exactly as it does today — this feature must never become a new way for task creation to break. This mirrors the failure posture already established throughout `apps/worker/src/repo-map.ts` ("never throws... the run proceeds exactly as it did before this feature existed").

## Mechanism

### `resolveDefaultBranchSha` in `apps/web/src/server/github-app.ts`

```ts
// Mirrors apps/worker/src/scm-provider.ts's function of the same name — deliberately
// duplicated, not imported, matching this file's existing precedent (see signAppJwt).
export async function resolveDefaultBranchSha(
  orgId: number,
  repoFullName: string,
): Promise<string | undefined> {
  const installationId = await findInstallationForRepo(orgId, repoFullName); // new, mirrors
                                                                              // /api/connections/github/repos'
                                                                              // resolution logic
  if (installationId === undefined) return undefined;

  const { token } = await getInstallationToken(installationId);
  const repoRes = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!repoRes.ok) return undefined;
  const { default_branch: branch } = (await repoRes.json()) as { default_branch: string };

  const commitRes = await fetch(`${GITHUB_API}/repos/${repoFullName}/commits/${branch}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!commitRes.ok) return undefined;
  const { sha } = (await commitRes.json()) as { sha: string };
  return sha;
}
```

Unlike the worker's version, failures here return `undefined` rather than throwing — every caller in this feature treats "can't tell" identically to "not mapped, but skip the prompt" (see Error handling), so there's no need to propagate a distinct error.

### `GET /api/repos/map-status`

```ts
export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const repoFullName = new URL(request.url).searchParams.get("codebase");
  if (!repoFullName) return NextResponse.json({ error: "codebase required" }, { status: 400 });

  const sha = await resolveDefaultBranchSha(ctx.orgId, repoFullName).catch(() => undefined);
  if (!sha) return NextResponse.json({ mapped: false, checkable: false });

  const cached = await getRepoMap(ctx.orgId, repoFullName, sha);
  return NextResponse.json({ mapped: Boolean(cached), checkable: true });
}
```

`checkable: false` distinguishes "couldn't determine" from "determined and it's a miss" — the frontend treats both as "don't show the banner" for the initial check, but treats a mid-poll `checkable: false` as an error to surface via the same fallback message described in Error handling, not as silence.

Triggering the warm job (needed only for the "Wait" choice) reuses the same authenticated org context; exact request shape (e.g. `POST` to the same route) is left to implementation planning.

### Task-creation form flow

1. On codebase selection change, call `GET /api/repos/map-status?codebase=...`. If `mapped: true` or `checkable: false`, no banner — form behaves exactly as today.
2. If `mapped: false` and `checkable: true`, show the inline banner (see mockup) with "Wait for the map, then create task" / "Start now without it".
3. **Start now** → submit via the existing, unchanged `POST /api/tasks` flow.
4. **Wait** → trigger the warm job, show the waiting state (spinner, explanatory copy, escape hatch — see mockup), poll `map-status` every ~2–3s.
   - Poll returns `mapped: true` → auto-submit via the existing `POST /api/tasks` flow.
   - User clicks the escape hatch → same as "Start now."
   - Warm-job trigger fails synchronously, or polling fails repeatedly → show a short explanatory message and fall through to "Start now" automatically (see Error handling), rather than leaving the user to find the escape hatch themselves.

### UX reference

Two states, approved via mockup during design:

- **Decision banner** (inline, appears below the codebase field, rest of form stays visible/fillable): explains the tradeoff in one or two sentences, offers "Wait for the map, then create task" and "Start now without it".
- **Waiting state** (same location, form disabled underneath): spinner, "Preparing repo context…" with a rough time expectation, progress indicator, and "Never mind, start without it" always visible.

## Error handling

| Failure | Behavior |
|---|---|
| Map-status check can't run at all (no GitHub connection, API error) on initial selection | No banner shown; task creation proceeds normally. |
| Triggering the warm job fails synchronously (queue down) | Show a brief message ("couldn't start mapping — continuing without it") and fall through to "Start now" automatically. |
| Polling fails repeatedly while waiting | Stop polling, show the same fallback message, fall through to "Start now" automatically. |
| Generation never finishes (crash, unusually large repo) | No automatic timeout — the escape hatch is the only way out, by design (see Design decisions). |
| User closes the tab while waiting | No cleanup needed — the task was never created. |

## Testing

- `resolveDefaultBranchSha` (apps/web): installation not found → `undefined`; GitHub repo lookup fails → `undefined`; commit lookup fails → `undefined`; happy path returns the resolved sha.
- `GET /api/repos/map-status`: unauthorized → 401; missing `codebase` → 400; cache hit → `{ mapped: true }`; cache miss → `{ mapped: false, checkable: true }`; sha resolution failure → `{ mapped: false, checkable: false }`.
- `warmRepoMap`'s existing cache-check-before-sandbox behavior already has coverage from PR #156 — no new test needed; implementation should confirm (not assume) that calling it twice in quick succession for the same repo+sha only provisions a sandbox once.
- Frontend interaction tests (banner appears on miss, polling stops on hit, escape hatch works) — approach to be determined during implementation planning.
- No new end-to-end spec committed to in this design (see Out of scope).
