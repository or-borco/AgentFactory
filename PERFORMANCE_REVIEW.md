# Performance Review — Why Agent Runs Feel Slow

Reviewed: `apps/worker` (run pipeline), `apps/web` (polling/data layer), `packages/db`, `packages/queue`.
Findings are ordered by expected impact on run turnaround time.

## 1. The worker processes one run at a time (highest impact)

`apps/worker/src/worker.ts` creates the BullMQ `Worker` with no `concurrency` option, so it
defaults to **1**. An agent turn can take minutes (SDK loop + tool calls inside the sandbox), and
during that time every other queued run — for any task, agent, or org — just waits. With two or
three tasks running "in parallel," each one appears to take N× longer than it actually does.

**Recommendation:** pass `{ connection: queueConnection, concurrency: N }` (start with 4–8; each
job is mostly I/O-wait on the sandbox, so the host can handle far more than 1). Sandboxes are
per-session, so concurrent runs don't collide. Longer term, add a per-session lock (BullMQ group
or job id keyed by sessionId) so two runs of the *same* session can't interleave.

## 2. Redundant GitHub API round trips on every run

Per run with a codebase + issue link, the worker does all of this sequentially
(`scm-provider.ts`):

- `resolveCloneTarget` → `findInstallationForRepo` → for **each** GitHub connection: mint an
  installation token (RS256 JWT + API call) and list **all** its repos, just to find which
  installation can see the repo. Then mint **another** token for the clone URL.
- `fetchIssue` repeats the exact same `findInstallationForRepo` scan and mints yet another token.
- `pushChangesIfDirty` mints another token; `openDraftPullRequest` mints another and re-fetches
  the repo's default branch.

That's ~6–10 GitHub API round trips per run, most of them recomputing the same answer.

**Recommendations:**
- Cache `repoFullName → installationId` (it changes only when installations change; even a
  5-minute in-memory TTL cache removes the repo-list scan from nearly every run).
- Cache installation tokens until near their ~1h expiry instead of minting one per operation.
- `listInstallationRepoNames` reads only the first page (`per_page=100`); orgs with >100 repos
  will silently fail to resolve. Paginate — or better, use
  `GET /repos/{owner}/{repo}/installation` (app JWT) to resolve the installation in one call
  with no listing at all.

## 3. Full `git clone` of the repo on first run

`cloneIntoSandbox` does a full-history clone. For a large repo this dominates the first turn's
provisioning time.

**Recommendation:** clone with `--filter=blob:none` (keeps commit ancestry, so the
`merge-base --is-ancestor` check in `pushChangesIfDirty` still works, unlike `--depth 1`).
Blobs are fetched lazily as the agent touches files.

## 4. Whole-workspace tar after every run

`worker.ts` calls `sandboxProvider.readWorkspace()` after **every** run: Docker tars the entire
`/workspace`, streams it out, and the worker parses/UTF-8-decodes every file — then, when a
codebase is attached, throws away everything except `changedFiles` (often a handful of files).
The kept snapshot is also stored as a `jsonb` blob on `runs.workspace_snapshot` per run.

**Recommendations:**
- When `changedFiles` is known, read just those files (e.g. `container.getArchive` per path or a
  single `tar -cf - <files>` exec) instead of the full tree.
- Skip the snapshot entirely when `changedFiles` is empty and a workspace exists (today it still
  tars everything just to produce `{}`).

## 5. Event persistence blocks the agent output stream

In `agent-runtime.ts`, every `__EVENT__` line does `await onEvent(...)` → one `INSERT` into
`events` — serialized with consuming the sandbox's stdout stream. A tool-heavy turn generates
many events, each adding a DB round trip of latency to stream processing.

**Recommendation:** decouple persistence from stream consumption — push events into an in-order
queue flushed concurrently (or batch-insert every ~250ms), keeping `seq` assignment synchronous.

## 6. No DB indexes on the hot polling paths

`packages/db/src/schema.ts` defines no secondary indexes. The web app polls
`/api/sessions/:id/events` every 1.5s, which joins `events → runs` filtered by
`runs.session_id` — a sequential scan of the append-only `events` table on every tick, forever
growing.

**Recommendation:** add indexes on `events(run_id)`, `runs(session_id)`, `messages(session_id)`,
`sessions(agent_id)`, and `tasks(session_id)`.

## 7. Polling re-downloads the entire transcript every 1.5s

The task page (`tasks/[taskId]/page.tsx`) and `sendMessage` in `mock/context.tsx` poll on
`setTimeout` chains that fetch **all** events for the session each tick (including every full
`text_delta` payload). Two problems:

- Payload and DB work grow linearly with session history; long sessions make every tick heavier.
- The `setTimeout` chains are never cancelled on unmount — navigating away leaves orphaned polls
  running (and `pollRun`/`pollRunStatus` can double up on the same run).

**Recommendations:** add an `?afterId=` cursor to the events endpoint and append client-side;
store the timeout id and clear it in the effect cleanup. Longer term this is the natural place
for SSE/WebSocket run streaming (already implied by ARCHITECTURE.md's event log).

## 8. Web: context re-renders the whole app

`AppDataProvider` rebuilds its `value` object on every render (no `useMemo`), so any state
change re-renders every consumer. The fake word-by-word reveal in `sendMessage` calls `setState`
every 45ms per word, and the task page ticks a 1s `setInterval` clock — each tick re-rendering
the full tree under the provider.

**Recommendations:** memoize the context value; scope the streaming reveal and the elapsed-time
clock to leaf components with local state.

## 9. Minor / cleanup

- `apps/worker/src/claude-runtime.ts` (`callClaude`) is dead code since the SDK moved into the
  sandbox — delete it.
- The run-start lookups in `worker.ts` (`getMessage`, `getLatestProviderSessionRef`,
  `getTaskBySessionId`, `getTeam`) are sequential awaits; the independent ones can run in
  `Promise.all` (saves a few DB round trips per run).
- `/api/sessions/:id/runs` returns full `workspaceSnapshot` blobs for every run in the list;
  return it only for the run that needs it (the task page uses just one).

## Suggested order of work

1. Worker `concurrency` (one line, biggest perceived win when multiple runs queue).
2. GitHub installation/token caching + pagination fix (#2).
3. DB indexes (#6) and events cursor (#7) — keeps polling flat as sessions grow.
4. Changed-files-only workspace read (#4) and blobless clone (#3).
5. Event batching (#5), React memoization (#8), cleanup (#9).
