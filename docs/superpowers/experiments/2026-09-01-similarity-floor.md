# Similarity floor calibration (or-borco/AgentFactory#135)

## Background

Issue #135 was filed as an investigation, not a prescribed fix, after three independent
observations (PR5's manual test, PR6's manual test, PR7's own eval experiment) plus a live
example from the user (task 60: "write a simple banana bread recipe" retrieved 7 excerpts from
`context-retrieval-design.md` / `ARCHITECTURE.md` scored 52-54%) all showed the same pattern:
off-topic queries were clearing `SIMILARITY_FLOOR` (0.35) and injecting irrelevant retrieved
content into runs.

Three competing, undistinguished hypotheses were listed in the issue:
1. `SIMILARITY_FLOOR` is genuinely miscalibrated (too low).
2. The `bge-small-en-v1.5` embedding model compresses scores into a narrow band regardless of
   true relevance — no floor value would fix this.
3. The corpus is small/thematically narrow enough that "least dissimilar of a bad set" naturally
   lands near 50%.

This experiment gathers the evidence to distinguish between them, per systematic-debugging's
Phase 1 (root cause investigation before any fix).

## Method

A throwaway script (`apps/worker/score-distribution.mjs`, not committed) called the real
production retrieval code path — `getEmbedder().embedQuery()` and
`searchContextChunks(teamId, embedding, limit)` from `packages/db` — against two real corpora,
with `limit` set high enough to see the full ranked list rather than just the top `RETRIEVAL_K`.

**Corpus 1 — "Platform team"**, the existing 7-document corpus used throughout PR5-PR7
(`engineering-handbook.md`, `customer-faq.md`, `CLAUDE`, `ARCHITECTURE`, `ALPHA-SCOPE`,
`PRODUCT-DEFINITION`, `context-retrieval-design`), 180 chunks. 13 queries: 7 off-topic/gibberish
(banana bread, puppy names, weather, movie recommendation, car maintenance, two rounds of random
tokens), 6 on-topic (targeting alpha scope, billing, onboarding, customer support, tool policy,
personas — one per distinct document).

**Corpus 2 — "Projects team"**, a second corpus ingested for this experiment through the real
ingestion pipeline (`ingestContextItem` in `apps/worker/src/context-ingest.ts` — real chunking,
real embedding, real `context_chunks` rows), 4 new documents on different topics (employee
benefits, incident response, sales compensation, data retention), 17 chunks. 15 queries: 6
on-topic (one per document, one covering two facts in one doc), 6 off-topic/gibberish, and 3
deliberately **borderline** — topically adjacent to the corpus (HR/security-flavored) but not
actually answered by any of the four documents (expense reimbursement, resignation notice
period, security vulnerability disclosure process).

## Results

### Corpus 1 (7 docs, 180 chunks) — 13 queries

| Query type | Best-chunk score range |
|---|---|
| Off-topic / gibberish (7 queries) | 0.457 – 0.556 |
| On-topic (6 queries) | 0.642 – 0.881 |

Clean gap: nothing irrelevant broke 0.556; nothing relevant fell below 0.642.

### Corpus 2 (4 docs, 17 chunks) — 15 queries

| Query type | Best-chunk score range |
|---|---|
| Off-topic / gibberish (6 queries) | 0.372 – 0.511 |
| On-topic (6 queries) | 0.764 – 0.812 |
| Borderline, uncovered (3 queries) | 0.583 – **0.625** |

Off-topic/gibberish and genuine on-topic queries separate even more cleanly here (max 0.511 vs.
min 0.764). But the three borderline queries — real HR/security-adjacent questions that this
4-document corpus simply does not answer — landed at 0.583, 0.602, and 0.625: two of the three
would still clear a 0.6 floor and inject content that does not actually answer the question,
even though nothing off-topic or nonsensical ever does.

## Analysis against the three hypotheses

- **Hypothesis 2 (embedding compression, in the strong form "no floor could work") is not
  supported.** Both corpora show a real, substantial, repeatable gap between off-topic and
  on-topic best-chunk scores (0.556 vs 0.642 in corpus 1; 0.511 vs 0.764 in corpus 2). The model
  discriminates; the floor was just set below where the discrimination happens.
- **Hypothesis 1 (floor miscalibration) is the dominant, well-supported explanation** for the
  original off-topic bug (#135's reported symptom): raising the floor to 0.6 correctly excludes
  every off-topic and gibberish query's best chunk across both corpora (max observed: 0.556) while
  keeping every genuinely on-topic query's best chunk (min observed: 0.642).
- **Hypothesis 3 (corpus narrowness) has a secondary, narrower manifestation** than originally
  framed: it doesn't explain the off-topic case (that's cleanly hypothesis 1), but it does explain
  the corpus-2 borderline results — a small, thematically clustered corpus can score a
  topically-adjacent-but-non-answering query high enough to slip past even a well-calibrated
  floor. This is a distinct failure mode from #135's original symptom (nonsense/unrelated content
  scoring moderately) — it's *plausible-sounding, on-theme, but non-answering* content scoring
  moderately-high. Not claimed to be fixed by this change.

## Decision

Raise `SIMILARITY_FLOOR` from `0.35` to `0.6` in `apps/worker/src/context-retrieval.ts`. This is
supported by 28 queries across 2 independent real corpora (197 chunks total), not the single
5-query/1-corpus sample from the initial investigation. `RETRIEVAL_K` (12) and
`RETRIEVAL_BUDGET_BYTES` (8192) are unchanged — this experiment did not test them and #135 was
never about them.

**Residual, explicitly out of scope for this fix:** the corpus-2 borderline results show that a
similarity floor, however well-tuned, cannot distinguish "on-theme but doesn't actually answer
the question" from "genuinely relevant" — both score in a broadly similar range when the corpus is
small and thematically clustered. Solving that would need a different mechanism (e.g., an
LLM-based relevance check on top of the embedding score) and is not part of this change. Worth a
follow-up issue if it turns out to matter in practice; not filed yet since it hasn't been observed
outside this synthetic test corpus.
