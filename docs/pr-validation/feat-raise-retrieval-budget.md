# Validating: raise the retrieval budget (#154)

## The one-line claim

An attached document that used to arrive 22% complete, tail-first, now arrives whole and in the
order it was written.

---

## 1. The regression test that is the whole point

`context-retrieval.test.ts` → **"injects all of a T-070-sized attached document"** reconstructs
run 27 exactly: nine chunks of 749/853/975/1143/388/1124/561/510/433 bytes, scored the way the
real run scored them — the tail (Rollout, Non-goals, Testing-tail) outranking every normative
section, because the task description's procedural half embedded closer to them.

```bash
npx vitest run --project unit apps/worker/src/__tests__/context-retrieval.test.ts -t "T-070-sized"
```

| | Before | After |
|---|---|---|
| Chunks injected | 3 of 9 | **9 of 9** |
| Bytes | 1,504 (22.3%) | **6,736 (100%)** |
| Retry policy (chunk 1) | ✗ | **✓** |
| Error classifiers (chunk 2) | ✗ | **✓** |
| UI / state machine (chunks 3–4) | ✗ | **✓** |

## 2. See it against the real corpus

The document is still attached to task 70 in the development database:

```bash
docker exec agentfactory-postgres-1 psql -U agentfactory -d agentfactory -c \
  "select item_title, chunk_idx, rank, round(score::numeric,3) from run_context_retrievals
   where run_id = 27 order by rank;"
```

Nine rows, three of them from `transcriber-retry-spec.md` — chunk_idx 6, 7 and 8. Those are its
last three sections.

To see the new behaviour, re-run task 70 (or create a task with the same attachment) and compare
the same query for the new run id. The task-sourced rows should be `chunk_idx` 0–8, contiguous and
in order.

The run detail page's **Context** tab shows the same thing more legibly — per-segment bytes and
percentages, with task-sourced excerpts labelled.

## 3. Why both constants had to move

The thing that makes this non-obvious: **team retrieval does not get a fixed slice.** It gets
`RETRIEVAL_BUDGET_BYTES − (bytes the task actually used)` (`context-retrieval.ts:195`). Raising
the floor alone transfers room rather than creating it.

| Configuration | Task gets | Team gets |
|---|---:|---:|
| Old — 2 KB floor / 8 KB ceiling | 1,504 B | 6,688 B available |
| 8 KB floor, ceiling unchanged | 6,736 B | **1,456 B — starved** |
| **8 KB floor, 16 KB ceiling (this PR)** | **6,736 B** | **9,648 B** |
| 8 KB floor, 32 KB ceiling | 6,736 B | 26,032 B |

Asserted directly, so the coupling cannot be broken silently:

```bash
npx vitest run --project unit apps/worker/src/__tests__/context-retrieval.test.ts -t "leaves team retrieval real room"
```

## 4. Why 16 KB and not 32 KB

The two sides carry very different levels of doubt.

- **The task side needs no measurement.** 22% → 100% of a document a human explicitly attached.
  There is no configuration in which that is worse.
- **The team side is genuinely uncertain, and a large ceiling could make it worse.** At 32 KB,
  team retrieval grows from 6.5 KB to 25.4 KB — roughly four times more of a corpus that run 27
  established was actively harmful for that task (#138 — one injected excerpt read
  "**No automatic retries**" on a task whose purpose was adding retries).

16 KB fixes the task side completely while holding the team side near where it is today
(9.4 KB vs 6.5 KB). **Nothing uncertain is being changed.**

Headroom is not the constraint either way: run 27's entire composed prompt was 10,679 characters
— roughly 2,700 tokens against Sonnet 5's 1M window, or 0.27%.

---

## Test coverage against the issue's acceptance criteria

| Criterion | Where |
|---|---|
| Constants at 16384 / 8192 with T-070 cited | `context-retrieval.ts:14-61`; pinned in "pins K, the similarity floor, and the byte budgets" |
| T-070 regression — 9-chunk document injected whole | "injects all of a T-070-sized attached document" |
| `skipOversized` keeps a later small chunk | "keeps a later chunk that fits after skipping one that does not" |
| Default still stops at first overflow | "still stops at the first overflow, preserving the contiguous prefix" |
| Document that fits whole goes in `chunkIdx` order | "injects a document that fits whole in chunk_idx order, not score order" |
| Document too large falls back to score order | "falls back to score order within a document that cannot fit whole" |
| Team-only sees the full ceiling | "a task with no documents leaves the full budget for team retrieval" (pre-existing, still passes) |
| Task chunks bypass the floor, team chunks do not | "keeps a task chunk scored well below the similarity floor" (pre-existing) |
| `rank` contiguous from 1 | "keeps rank contiguous from 1, which the eval judge counts against" |

**10 new unit tests; all 29 pre-existing retrieval tests pass unchanged**, which is the useful
signal — the task-side rework did not alter any behaviour that was already specified.

Suite: unit **496** ✓ / db-integration **149** ✓ / queue-integration **11** ✓ (baseline on `main`:
486 / 149 / 11).

No e2e: this branch touches only `apps/worker`. (The suite is also independently red on `main` in
this environment — see #156 for the details.)

## Two stale comments fixed in passing

- `eval-judge.ts` claimed `RETRIEVAL_BUDGET_BYTES = 8192` when justifying `MAX_RETRIEVED_CHARS`.
  The backstop is still valid but its headroom is now 2× rather than 4×, which is noted there.
- A test comment did the arithmetic `8192 - 2048 = 6144`.

## Worth a second opinion

- **Shipping without an experiment** departs from the precedent of `SIMILARITY_FLOOR` (#135) and
  the prompt-ordering work. Deliberate: those measured choices whose *direction* was unclear. Here
  the task side's direction is not in doubt, and the team side is held roughly constant precisely
  so that nothing uncertain is being changed. The experiment belongs with the *next* ceiling
  increase, after #138.
- **`selectTaskChunks` is new logic**, not just a constant change — grouping by document, ordering
  documents by best chunk score, whole-fit first, then score-ranked leftovers. Worth reading.
- **#152 substantially defuses this PR.** Once an attached document is on disk in the sandbox, the
  task slice no longer has to *carry* the specification. This stays worth having — excerpts put
  the right passage in front of the model without costing a file read — but it stops being
  load-bearing. If only one of the two lands, it should be #152.
