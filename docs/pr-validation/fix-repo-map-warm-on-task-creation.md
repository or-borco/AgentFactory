# Validating: repo-map warm on task creation + cache re-check (#153)

## The one-line claim

The repo map now gets scheduled when a task is created, and a run that misses the cache waits
briefly for it instead of giving up instantly. On task T-070 the map existed for 7 of the run's
8 minutes and was never read.

---

## 1. The bug, seen directly

**Before:** create a task with a codebase, and watch the worker log. Nothing schedules a map.

```bash
docker exec agentfactory-postgres-1 psql -U agentfactory -d agentfactory \
  -c "select repo_full_name, commit_sha, created_at from repo_maps order by created_at desc limit 5;"
```

On `main`, creating a task against a never-seen repo adds no row here until a run misses the
cache — which is exactly when it is already too late for that run.

**After:** the row appears shortly after task creation, before any run starts.

## 2. Reproduce the whole race

1. Pick a repo with **no** cached map for its current HEAD (check the query above).
2. Create a task with that repo as its codebase.
3. Immediately run it.

**What to look for in the worker log:**

```
[run N] clone: …ms
[run N] repo map (available): …ms          <-- was "(miss - generation deferred)"
Repo map for owner/repo@sha landed after 4000ms of polling
```

The `Context` tab on the run should show a populated **Repo map** segment rather than
`repo_map_pending`.

**If the warm loses anyway** (a very cold repo, generation slower than usual), the log says so
explicitly and the run proceeds exactly as it does today:

```
Repo map for owner/repo@sha did not land within 20000ms; running without it
```

## 3. Why 20 seconds, and why it is not enough on its own

Generation is measured at 33–38s. A poll alone would still lose. What makes the number work is
that the two halves compose:

| | T-070 actual |
|---|---|
| Task created | 22:04:40 |
| Run starts, misses cache, enqueues | 22:04:57 (**17s later**) |
| Map cached | 22:05:51 |
| Run finishes, never having seen it | 22:13:07 |

With the warm moved to task creation, generation starts at 22:04:40 instead of 22:04:57, and the
run's 20-second poll window covers the remainder. Head start *plus* poll closes it; either alone
does not.

**The cost is bounded and asymmetric.** 20 seconds of wall-clock against a run that took eight
minutes, and the agent demonstrably spent longer than that orienting by hand — at the cost of
model tokens, which waiting does not consume. The value is a better-oriented agent, not a faster
run.

## 4. The cache-hit path must stay free

The common case is a cache hit, and it must not pay a millisecond for any of this. Asserted
directly:

```bash
npx vitest run --project unit apps/worker/src/__tests__/repo-map.test.ts -t "never sleeps on a cache hit"
```

---

## Test coverage against the issue's acceptance criteria

| Criterion | Where |
|---|---|
| Task with `codebase` enqueues exactly one warm | `apps/web/src/app/api/tasks/__tests__/route.test.ts` — "warms the repo map when the task is created with a codebase" |
| Task without `codebase` enqueues none | same file — "does not warm anything for a task with no codebase" |
| Still 201 when the enqueue rejects | same file — "still returns 201 when the queue is down" |
| Miss resolving mid-poll returns the content | `repo-map.test.ts` — "returns the map when a warm job lands mid-poll" |
| Miss that never resolves returns `""` after the window | `repo-map.test.ts` — "gives up after the full poll window rather than waiting forever" |
| Cache hit returns immediately | `repo-map.test.ts` — "never sleeps on a cache hit" |
| Enqueue failure still polls | `repo-map.test.ts` — "still polls when the warm job could not be enqueued" |

**18 new unit tests.** Suite on this branch: unit **498** ✓, db-integration **149** ✓,
queue-integration **11** ✓ (baseline on `main`: 486 / 149 / 11).

The poll is tested with an injected instant `sleep` and a counted attempt budget, so the tests
assert the exact number of polls production would do without taking 20 real seconds.

## E2E status — read this before trusting the number

`pnpm test:e2e` is **already failing on `main`** in this local environment, and the failure count
is not even stable between runs (3–4 of 24, varying across five consecutive runs of identical
code). The failures are all in `context-documents.spec.ts`, `task-context-documents.spec.ts`, and
`run-context.spec.ts` — specs that wait for a document to leave the `Queued` state, which needs
the ingest worker running alongside the web app.

Seeding `agentfactory_test` did not change it. This is an environment gap, not a regression from
this branch, but it does mean **the e2e suite could not be used to validate this PR locally** —
worth confirming against CI, which runs the full suite on the pushed branch.

Two local-environment notes found along the way, neither caused by this branch:

- `.env.test.local` points the vitest db/queue projects at **`agentfactory`** (the development
  database, 66 tasks including T-070), while `apps/web/.env.local` points the app at
  **`agentfactory_test`**. That is backwards from what the names suggest. The db-integration
  suite's own comment says it "truncates" its database.
- `next dev`'s single-instance guard is per-directory, not per-port, so Playwright cannot start
  its own server on :3100 while a dev server is running from the same checkout. Running e2e from
  a second git worktree works (`pnpm install` there took 5 seconds).

## Worth a second opinion

- **`CACHE_POLL_TIMEOUT_MS = 20_000` is a judgement call, not a measurement.** It comes from one
  data point. If it is wrong in either direction, the constant is the only thing that changes.
- **A queue outage still polls.** The map may already be in flight from an earlier warm, so
  failing to enqueue is not a reason to skip looking.
- **Not proposed, deliberately:** putting generation back on the run's critical path. That was
  measured (~35s of run 32's 101s) and removed for good reason.
