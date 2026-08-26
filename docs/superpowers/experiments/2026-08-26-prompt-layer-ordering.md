# Prompt layer ordering — experiment

**Date:** 2026-08-26
**Status:** concluded; result applied in `apps/worker/src/prompt-composition.ts`

## What prompted this

Run #37 (task T-077, Release notes writer, claude-haiku-4-5) was **provably** given every
instruction it needed — the new `runs.prompt_segments` record shows `agent_system_prompt` at 571
bytes containing the `ZEBRA-CHECK` footer rule, and `team_context` at 488 bytes containing the
"open with the rocket emoji" rule. Its output honoured the mid-body rules (grouping, PR
references, tense, word limits) and silently dropped three: the opening emoji and both closing
footers. It then claimed in its final paragraph to have included "the required footer lines".

Recording the prompt (the visibility feature) answered "was it told?" — yes. This experiment
answers the next question: does the *arrangement* of the layers explain why it didn't comply?

## Setup

Both experiments replay **run #37's exact five layer texts**, pulled from
`runs.prompt_segments`. Layer content, user request, and model (`claude-haiku-4-5`) are held
identical across variants; the only thing that varies is the order the layers are concatenated
in, plus one variant that appends a checklist.

Layer sizes for that run — note the imbalance the experiment is probing:

| layer | bytes | share |
|---|---|---|
| platform_preamble | 444 | 6.3% |
| environment | 1,092 | 15.5% |
| team_context | 488 | 6.9% |
| **repo_map** | **4,460** | **63.2%** |
| agent_system_prompt | 571 | 8.1% |

Scoring is mechanical — each check is a string/regex test for one requirement the prompt
actually stated. No model judgement:

- rocket emoji appears before the first `Added`/`Fixed` group header
- entries grouped under Added / Fixed / Changed
- every bullet ends with its PR number in `[#N]` (trailing punctuation and the `(no-issue)` tag
  are permitted after it — both are separately mandated)
- contains `Questions? Ping #platform-releases.`
- contains `Compiled by the release desk.`
- no hallucinated tool-call markup

"Fully compliant" means one response passing **all** checks.

Two harnesses were used — one single-turn, one replaying a long tool transcript — 5 trials per
variant. They are not kept in the repo: their checks were hardcoded to instructions planted for
this test (`ZEBRA-CHECK`, a `#platform-releases` footer, `(no-issue)` tags) rather than to real
house style, so re-running them unchanged against a later prompt would score against rules that
no longer exist and quietly return meaningless numbers. The method above is enough to rebuild
one around whatever instructions actually apply at the time; the originals are in git history on
the commits that landed #115 and #116.

## Experiment 1 — single turn

| variant | rocket | grouping | PR ref | ping | zebra | no fake tools | **fully compliant** |
|---|---|---|---|---|---|---|---|
| control (map between team context and agent prompt) | 1/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | **1/5** |
| **repo_early** (map before both) | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |
| repo_last (map at the very end) | 5/5 | 4/5 | 4/5 | 5/5 | 5/5 | 5/5 | 4/5 |
| control + checklist | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 4/5 |
| repo_early + checklist | 5/5 | 5/5 | 4/5 | 5/5 | 5/5 | 5/5 | 4/5 |

## Experiment 2 — long agentic turn

Experiment 1 is single-turn, and its footers pass 5/5 even for the control, so it does **not**
reproduce run #37's failure. A real run spends a long turn exploring the repo before answering,
putting kilobytes of tool traffic between the system prompt and the moment of generation.
Experiment 2 replays an identical 6,819-byte synthetic exploration transcript for both variants.

| variant | rocket | grouping | PR ref | ping | zebra | no fake tools | **fully compliant** |
|---|---|---|---|---|---|---|---|
| control | 0/5 | 5/5 | 3/5 | 5/5 | 5/5 | 5/5 | **0/5** |
| **repo_early** | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** |

## Findings

1. **Ordering is the dominant factor, and the effect is large.** Across both conditions,
   `repo_early` was fully compliant 10/10; the control 1/10.
2. **The damage is concentrated in `team_context`.** The instruction that failed is the one
   living in the layer the repo map separated from the generation point. Instructions in
   `agent_system_prompt` — adjacent to generation in both orders — largely survived either way.
3. **Length between instruction and generation makes it worse, not better.** The control's
   rocket compliance falls from 1/5 to 0/5 once a realistic tool transcript intervenes, and its
   PR-reference compliance falls from 5/5 to 3/5. The failure mode is the normal operating
   condition for a real run, not an edge case.
4. **Restating requirements in an appended checklist did not help.** It costs 552 bytes and
   scored *worse* than reordering alone (4/5 vs 5/5). Reordering is free — identical bytes.
5. **`repo_last` is not the answer.** Moving the map to the very end scored 4/5 and degraded
   grouping, presumably by ending the prompt on descriptive bulk.

## Decision

Order becomes: `platform_preamble → environment → repo_map → team_context → agent_system_prompt`.

The general rule, recorded in the code: platform-authored constraints lead, machine-generated
reference material sits in the middle, and **human-authored instructions go last**. Any future
layer should be placed by that rule — retrieved context items and a skills index are both
generated bulk and belong before `team_context`, not after it.

## Confirmation in a real run

Run #38 (task T-075, same agent, same repo, same model) executed through the full worker
pipeline against the new ordering. Its stored `prompt_segments` confirm the arrangement that
actually shipped to the model:

```
1 platform_preamble     444 b
2 environment         1,092 b
3 repo_map            4,460 b
4 team_context          488 b
5 agent_system_prompt   571 b
```

Its deliverable — `RELEASE_NOTES_v0.1.0.md`, written and committed inside the sandbox — honoured
**7 of 7** stated instructions, including all three that run #37 dropped: the opening rocket, the
`Questions? Ping #platform-releases.` line, and the `Compiled by the release desk.` footer
(present exactly once, as specified).

One thing this surfaced that the offline experiments could not: **the agent's chat reply is not
the deliverable.** Run #38's final message is a summary that itself contains no rocket and no
footers; the compliant artefact is the committed file. Run #37 answered inline instead, so its
chat message *was* the deliverable and its omissions were real. Anyone scoring compliance — a
future eval harness especially — has to score the artefact the run produced, not the summary
text, or it will report false failures.

## What this does not establish

- **Single model, single task.** Only `claude-haiku-4-5` on one release-notes task. The
  mechanism (distance between instruction and generation) is general, but the magnitude is not
  measured elsewhere.
- **The two footers were never reproduced as failing.** They passed 5/5 in every variant of both
  offline experiments, yet failed in run #37. Whatever caused that — a longer transcript, many
  genuine tool results, or answering inline rather than into a file — is not captured here. Run
  #38 honoured them, but one passing run is not proof the mode is gone.
- **One run is not a rate.** The end-to-end confirmation is a single production run at 7/7. The
  10/10-vs-1/10 figures come from the offline harness, not from repeated real runs.
- **Single model, single task shape.** Release notes on one repo with `claude-haiku-4-5`. The
  mechanism generalises; the magnitude is unmeasured elsewhere.
