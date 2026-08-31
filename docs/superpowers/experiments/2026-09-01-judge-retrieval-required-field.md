# Judge retrieval-field omission — root cause and fix (or-borco/AgentFactory#134)

## Background

The eval judge's `report_eval` tool has an optional `retrieval` field: one entry per retrieved
excerpt, used to compute retrieval precision. `JUDGE_SYSTEM_PROMPT` explicitly instructs the
judge to always populate it when a `<retrieved>` block was sent. In real usage it did so in only
~20-25% of calls that had a genuine block to grade — PR7's own 10-run experiment got usable
retrieval data back on 2 of 10 runs.

Two hypotheses were tried live during PR7 and both disproven:
- Raising `JUDGE_MAX_TOKENS` from 8192 to 16384 fixed only 1 of 8 missing evals.
- Reordering the tool schema's properties (`retrieval` before `layers`) fixed 0 of 7.

Both were prompt/shape-level tweaks. Root cause was left open, tracked as #134, with logging
(`logRetrievalCoverageGaps`) added so the gap is at least visible in worker logs.

## Method

Per `superpowers:systematic-debugging`'s Phase 1, a throwaway script called the real
`report_eval` tool against the real Anthropic API (`claude-sonnet-5`, the judge's
`DEFAULT_MODEL_ID`) with two schema variants, holding the system prompt and user message fixed
within each scenario — the single-variable test the two disproven hypotheses were missing a
counterpart of:

- **BASELINE** — today's shipped schema: `required: ["layers"]`, `retrieval` present in
  `properties` but not required.
- **VARIANT** — identical schema except `required: ["layers", "retrieval"]`.

Two distinct scenarios, 10 real API calls per schema per scenario (40 calls total):

1. A diff artefact (adding an in-memory rate limiter) against a team-context layer, with a
   `<retrieved>` block containing 3 excerpts, one of them directly contradicting the artefact
   (an engineering-handbook rule to use a shared Redis limiter, not an in-memory one) — and a
   `<request>` block.
2. A reply-only artefact (a support agent's chat reply) against a different team-context layer,
   a `<retrieved>` block containing 2 excerpts, and no `<request>` block at all (to check the
   result isn't an artifact of one particular message shape).

## Results

| Scenario | BASELINE (optional) | VARIANT (required) |
|---|---|---|
| 1 — diff artefact, with request | 2/10 | 10/10 |
| 2 — reply artefact, no request | 3/10 | 9/10 |
| **Total** | **5/20 (25%)** | **19/20 (95%)** |

The baseline rate (25%) matches the ~20-25% observed in real production calls, confirming the
script reproduces the real failure. The variant — the exact same prompt and message, only the
`required` array changed — raised compliance to 95%.

## Analysis

This is a schema-level constraint, not a prompt-level suggestion, and behaves differently from
the two previously-tried fixes: `JUDGE_MAX_TOKENS` and property ordering are things the model
reads and may or may not act on; `required` is enforced by Claude's tool-use constrained decoding
itself. That explains why the two disproven hypotheses barely moved the number (1/8, 0/7) while
this one moved it from ~25% to ~95% — the earlier fixes never touched the actual mechanism
generating the omission.

The fix must stay **conditional**: a run with no `<retrieved>` block genuinely has nothing to
grade, and forcing `retrieval` to be required on every call would force the judge to invent
entries for excerpts that were never shown to it. `apps/worker/src/eval-judge.ts` already computes
"was a retrieved block actually sent" as a gate (`hasRetrievedBlock`, extracted from
`buildJudgeUserMessage`'s pre-existing inline check) — the same gate now decides whether
`retrieval` is required in the schema, so the message and the schema can never disagree about
whether there was something to grade.

## Decision

`judgeCompliance` now builds the `report_eval` tool via `buildReportEvalTool(hasRetrievedBlock(retrieved))`
instead of a single static tool constant. `logRetrievalCoverageGaps` remains in place — even at
95%, a rare remaining omission is still worth surfacing in logs, and the count-mismatch check
(reported chunks vs. injected chunks) is an independent concern this fix does not address.

**Residual, not addressed by this change:** scenario 2's variant run 10/10 still had one omission
(9/10, not 10/10) — the fix raises reliability substantially, it does not make it deterministic.
That residual is exactly what `logRetrievalCoverageGaps` exists to keep visible.
