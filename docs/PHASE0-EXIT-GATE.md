# Phase 0 exit gate — does shared context actually change the output?

> Tracks: [issue #69](https://github.com/or-borco/AgentFactory/issues/69)
> Status: **prerequisites merged, experiment not yet run**

## What this document is

Issue #69 is a validation exercise, not an engineering task — it says so explicitly, and
that's exactly why it needs a runbook instead of a code change. The thesis under test
(`PRODUCT-DEFINITION.md` §1–2) is that a team's shared context measurably improves output
quality over a bare agent. Nobody can close that out with a PR; it's closed out by running
the experiment and the tech lead writing down what they saw.

This doc operationalizes the issue's **Method** section so the experiment is easy to run
correctly, and gives the tech lead an anonymization/scoring kit instead of a manual process
that's easy to get wrong (e.g. accidentally leaving a branch name like `feat/with-context`
in a "blind" review bundle).

## Prerequisite check

Issue #69 names two prerequisites:

| Prerequisite | Status | Evidence |
|---|---|---|
| Shared context editor | ✅ Merged | `336fa2a` "Add shared context editor to teams-v2" (#63), `PR #77` |
| Compose `shared_context` into the prompt pipeline (#57) | ✅ Merged | `cab5ab1` "Inject team shared context into agent system prompt at run time", `PR #80`/`#81` |

Both prerequisites are in `main`. **The gate is unblocked** — the experiment itself has not
been run yet. Nothing in this repo tracks the 10 selected tasks or any scoring results, so
this is a from-scratch run.

## Task selection (do this first, by hand)

Pick 10 tasks from the real backlog per the issue's instructions — ordinary ones, not
showcase tasks. Suggested criteria to keep the sample honest:

- A mix of milestones (don't pick 10 frontend-only tasks)
- At least a couple that touch team-specific conventions (naming, error handling, layering)
  that only show up in the shared context — otherwise the experiment can't detect a
  difference even if one exists
- Nothing that's blocked or needs design discussion first — the gate measures execution
  quality, not requirements-gathering
- Record the list (task id, one-line description, milestone) in a sheet/doc before running
  anything, so the "ordinary, not cherry-picked" claim is checkable later

## Running each task twice

For each of the 10 tasks, produce two PRs against the same base commit:

1. **Variant "context"** — an AgentFactory agent configured with the team's real
   `shared_context`, same model, same task text.
2. **Variant "bare"** — the same model with a generic system prompt and no team
   `shared_context`, same task text, same repo/base commit.

Keep everything else identical: model, base branch/commit, task description text. The
only difference between the two runs must be presence/absence of shared context.

## Anonymizing the 20 PRs

Use `scripts/phase0-blind-review.mjs` to turn 10 pairs of branches into a blind review
bundle:

```bash
node scripts/phase0-blind-review.mjs prepare \
  --base main \
  --pairs pairs.json \
  --out phase0-review-bundle
```

`pairs.json` lists the 10 tasks and their two branches:

```json
[
  { "task": "task-123", "context": "agent/task-123-context", "bare": "agent/task-123-bare" },
  { "task": "task-124", "context": "agent/task-124-context", "bare": "agent/task-124-bare" }
]
```

The script:

- Exports `git diff <base>...<branch>` for each of the 20 branches
- Strips author/committer metadata, commit trailers, and the branch name itself from the
  diff text (nothing in the bundle should hint at which variant produced it)
- Shuffles the 20 diffs with a random label (`review-01.diff` … `review-20.diff`) and writes
  the shuffle key to `phase0-review-bundle/UNBLIND-KEY.json` — **do not open this file until
  after scoring**
- Emits `phase0-review-bundle/scorecard.csv` with one row per `review-NN.diff`, columns for
  the tech lead to fill in: `verdict` (`merge-as-is` / `merge-with-comments` / `no`) and
  `notes`

## Scoring

The tech lead reviews all 20 diffs in `phase0-review-bundle/` blind and fills in
`scorecard.csv` — verdict + freeform notes per review. Notes matter as much as the verdict:
if the thesis holds, the notes are what tell layer 3 (retrieval, M3) which parts of the
shared context actually did the work.

## Unblind and compare

```bash
node scripts/phase0-blind-review.mjs unblind \
  --bundle phase0-review-bundle
```

This joins `scorecard.csv` back to `UNBLIND-KEY.json` and prints a per-task table (context
verdict vs. bare verdict) plus an aggregate count. It does not compute a verdict on the
thesis — that's a judgment call for the discussion in the exit criterion below, not a script.

## What each outcome means (from the issue)

- **Clear gap in favour of shared context** — thesis validated. Take the scoring notes as
  input to how the M3 retrieval layer should rank chunks.
- **Indistinguishable** — the shared-context layer is not where the value is. Reorient
  toward the task board / multi-seat visibility before investing in retrieval
  infrastructure (M3).

## Exit criterion

Phase 1 does not begin until the 20-PR blind review above has actually been run and the
result discussed with the team. This doc and its script make that cheap to execute
correctly; they are not a substitute for running it.
