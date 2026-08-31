# Retrieved layer ordering and retrieval precision — experiment

**Date:** 2026-08-31 / 2026-09-01
**Status:** concluded — shipped ordering not falsified (inconclusive at this task shape, no evidence it is worse), tuning constants left unchanged pending a re-measurement

## What prompted this

`apps/worker/src/prompt-composition.ts:130-135` places `retrieved_context` between `repo_map`
and `team_context`, ahead of ARCHITECTURE.md §3's stated order (`shared_context` then retrieved
items). The comment calls this "a hypothesis, not a measurement" and defers the real test to PR 7,
once real documents and real retrieval exist. This is that test, plus the retrieval-precision
measurement PR 7 also exists to produce.

## Part 1 — real-corpus retrieval precision (Task 6, Steps 1-2)

Uploaded a real 7-document corpus to one team (`CLAUDE.md`, `ARCHITECTURE.md`,
`docs/ALPHA-SCOPE.md`, `docs/PRODUCT-DEFINITION.md`, a design spec, plus 2 pre-existing docs), ran
10 real tasks against it through the full worker pipeline (6 on-topic, matched to specific
documents; 4 deliberately off-topic), and triggered a real LLM-judge eval on every run.

**A judge-reliability gap surfaced and blocked most of the intended sample.** All 10 runs
genuinely retrieved context (7-12 real excerpts each, well under the 8 KB retrieval budget), but
the judge populated the optional per-excerpt `retrieval` field in only 2 of 10 responses (20%)
despite the system prompt instructing it to always report retrieval when a block is present. Two
hypotheses were tested live against the real judge and both were disproven:

- Raising `JUDGE_MAX_TOKENS` 8,192 → 16,384 and re-running the 8 missing evals fixed only 1 of 8.
- Reordering the tool schema to declare `retrieval` before `layers` (on the theory the model fills
  required-adjacent fields first) and re-running the remaining 7 fixed 0 of 7.

Both changes were reverted; neither is present in the shipped code. This is a genuine judge
prompt-adherence gap, not a token-budget or schema-ordering artifact, and is worth a dedicated
follow-up — it is out of scope for this experiment to fix.

**Result: only 2 of 10 runs have judge-graded retrieval precision.**

| Run | Topic | Excerpts retrieved | Relevant | Precision |
|---|---|---|---|---|
| 10 — "Alpha scope for context work" | on-topic | 12 | 5 | 0.42 |
| 17 — "Banana bread recipe" | off-topic | 7 | 0 | 0.00 |

Qualitative read of the rejected-excerpt reasons (the judge's stated `reason` per chunk):

- **Run 10 (on-topic):** the 7 rejected chunks were whole unrelated sections of the same
  spreadsheet-derived document — M1/M4/M6 deferred-item tables and a "data model gaps" table —
  pulled in alongside the 5 relevant M3 chunks. The retrieval budget was not binding (6,397 of
  8,192 bytes used); all 12 ranked candidates fit and were injected. This reads as a ranking/chunk-
  granularity problem, not a budget problem: the chunker is splitting a large table document into
  pieces coarse enough that unrelated sections rank inside the top 12.
- **Run 17 (off-topic):** the similarity floor did not filter the query at all — a banana-bread
  request still returned 7 excerpts, all correctly judged irrelevant, instead of triggering the
  `no_relevant_chunks` omission path. `SIMILARITY_FLOOR` (0.35) let through content with no
  semantic relationship to the request.

Both data points point in a direction (`SIMILARITY_FLOOR` too permissive; `RETRIEVAL_K` pulling in
a rejected tail even when the budget has room to spare), but **n = 2 is far short of what Step 5
needs to change a shipped constant.** See [Decision on tuning constants](#decision-on-tuning-constants) below.

## Part 2 — layer ordering replay (Task 6, Step 3)

Replayed run 11's exact stored `prompt_segments` — request: *"How is billing calculated for agent
runs, and is there a charge for failed or cancelled runs?"* — against `claude-haiku-4-5`, 10
samples per arm, holding every layer's text identical and varying only the order:

- **Arm A (shipped):** `platform_preamble → environment → repo_map → retrieved_context →
  team_context → agent_system_prompt`
- **Arm B (ARCHITECTURE.md §3 order):** `platform_preamble → environment → repo_map →
  team_context → retrieved_context → agent_system_prompt`

Run 11 was chosen because its retrieved layer is substantial (8,269 bytes) and directly contains
the answer (a `customer-faq.md` excerpt stating the exact billing policy), making compliance
mechanically checkable — the same method as the 2026-08-26 experiment, adapted from "does the
output honour a formatting instruction" to "does the output correctly state the retrieved facts,"
since this team's `team_context` layer carries background domain facts rather than the earlier
experiment's imperative formatting rules (rocket emoji, footer lines). That is a real difference
from the original setup and is called out in [What this does not establish](#what-this-does-not-establish).

Five mechanical checks, each a regex against the response text:

1. States charging is per successful run
2. States explicitly no charge for failed runs
3. States explicitly no charge for cancelled runs
4. Mentions Stripe as the billing system
5. States there is no seat-based pricing

"Fully compliant" means one response passing all five.

| variant | per-run | no-charge-failed | no-charge-cancelled | Stripe | no-seat | **fully compliant** |
|---|---|---|---|---|---|---|
| **A — shipped** (retrieved before team_context) | 10/10 | 10/10 | 10/10 | 10/10 | 9/10 | **9/10** |
| **B — arch order** (retrieved after team_context) | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | **10/10** |

(An earlier scoring pass under-counted the first check — the regex missed "per successful **agent**
run" — and showed a much larger, spurious 4/10 vs 6/10 gap. Re-scoring the same saved transcripts
with the corrected regex, no new API calls, produced the table above. The one real miss in Arm A
(sample 4) genuinely omitted the "no seat-based pricing" fact; every other check across both arms
passed on every sample.)

## Findings

1. **The direction matches the original experiment, but the effect size does not.** Arm B
   (retrieved farther from the repo map, closer to generation) scored no worse than Arm A on every
   check and one sample better overall — consistent with "closer to generation compiles more
   faithfully," never Arm A beating Arm B on anything. But 9/10 vs 10/10 is not the 1/10 vs 10/10
   gap the original experiment found for `team_context`'s imperative instructions.
2. **The task shape explains most of the gap between the two experiments, not the ordering
   change.** Run 11 is a single-turn Q&A with no tool-use transcript between the system prompt and
   generation — the original experiment's Experiment 2 (the condition that actually reproduced
   run #37's failure) required a realistic multi-kilobyte tool transcript to separate the arms.
   Both arms here are near ceiling because there is nothing pushing the answer away from its
   instructions.
3. **`team_context` in this dataset is not a fair analog for the original experiment's layer.**
   The original run's `team_context` carried explicit imperative formatting rules (an emoji, two
   footer lines) that are trivial to fail mechanically. This team's `team_context` is background
   domain facts (terminology, stack, external systems) with no comparably strict imperative for
   this particular task, so there was little for reordering to break.

## Decision on tuning constants

None of the three constants are changed by this experiment.

- **`SIMILARITY_FLOOR` (0.35):** run 17's data argues for raising it — an unambiguously off-topic
  request still returned 7 excerpts, all irrelevant, instead of the `no_relevant_chunks` omission
  path. This is exactly the failure mode the plan's raise-it rule describes. But it is one run.
- **`RETRIEVAL_K` (12):** run 10's data argues for lowering it — the budget was never binding
  (6,397 of 8,192 bytes used) and the bottom 7 of 12 ranked chunks were rejected as irrelevant,
  matching the plan's lower-it rule. Again, one run.
- **`RETRIEVAL_BUDGET_BYTES` (8,192):** no evidence to raise it. Neither graded run came close to
  the budget ceiling, and no rejected chunk was reported as dropped for space rather than
  relevance.

Both directional signals are real but rest on a sample of 2 graded runs against an intended 10 —
the judge-reliability gap in Part 1 cut the usable data to a fifth of what Task 6 was scoped to
produce. Changing a shipped retrieval constant on n=2 is not something this experiment is willing
to do; the honest conclusion is that the tuning question is **currently unanswered**, not answered
in either direction. Re-run Step 2's data collection once the judge-reliability gap has its own
fix, then revisit `SIMILARITY_FLOOR` and `RETRIEVAL_K` against the fuller sample.

The layer ordering itself is a separate question from the tuning constants. Part 2's result is
directional, not a confirmation: Arm B (ARCHITECTURE.md order) scored no worse than the shipped
order on every check and one sample better overall, on one task shape with no imperative
team-context instruction and no long tool transcript — see
[What this does not establish](#what-this-does-not-establish). That is not evidence the shipped
order is wrong, so `prompt-composition.ts` is unchanged. It is also not the same strength of
result as the original 10/10-vs-1/10 finding, so this should not be cited as "the ordering
question is closed."

## What this does not establish

- **Judge reliability is an open problem, not a solved one.** Two tuning hypotheses were
  disproven (token budget, schema field order) but no working hypothesis was found. Anything past
  "it's not those two things" is unconfirmed.
- **The ordering replay used a task with no imperative team-context instruction and no long tool
  transcript.** Both conditions were present in the original experiment's strongest result
  (Experiment 2, 10/10 vs 0/10) and absent here. A near-ceiling 9/10-vs-10/10 result on this task
  shape should not be read as "ordering barely matters" — it may only mean this particular task
  and layer content had little room to fail either way.
- **Single model, single task, single run replayed.** `claude-haiku-4-5` on one billing-FAQ
  question, from one real run's stored segments. The mechanism (proximity to generation) is
  general per the original experiment; this replay neither strengthens nor weakens that claim
  beyond confirming the shipped order is not worse.
- **The retrieval-precision tuning evidence is thin by design of this run, not by the method.**
  2 of 10 planned samples, for the reason stated above — not because the method only collects 2.
