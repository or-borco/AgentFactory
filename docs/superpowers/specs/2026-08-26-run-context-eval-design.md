# Run context evals — design

**Date:** 2026-08-26
**Status:** approved in brainstorming; implementation plan to follow
**Prior art:** step B of `2026-08-26-run-prompt-visibility-design.md`'s follow-ups, informed by
`docs/superpowers/experiments/2026-08-26-prompt-layer-ordering.md`.

## Problem

#114 records the exact prompt every run received; #115/#116 reordered the layers because a run
provably dropped instructions it was given. What the team still cannot do is ask, of any
particular finished run: *did it follow the context we wrote?* Answering today means a human
re-reading the team context, the agent prompt, and the run's diff side by side. Nobody does
that, so nobody knows which parts of the context are earning their bytes.

## Goal

On any completed run, a user can trigger an evaluation and get back a scored, evidenced report:
which human-authored instructions the run followed, which it ignored, and proof either way.
Manual trigger only — the user decides when a run is worth the judge call.

## Ground truth this design relies on

- `runs.prompt_segments` stores the literal segments the model received (#114). The join of the
  texts is the sent prompt; `prompt_hash` proves it.
- The ordering experiment's hardest-won lesson: **the chat reply is often not the deliverable.**
  Run #38 complied fully in its committed file while its summary message contained none of the
  required markers. Any scorer that grades the wrong document produces confident nonsense.
- The worker already runs three BullMQ queues (`run`, `sandbox-teardown`, `repo-map-warm`) and
  processes run jobs one at a time; a run takes ~60s median.
- The task page already has a tab bar (`transcript | files | context`) and polls run status on a
  timer; `RunContextPanel` renders the stored segments and is the closest UI template.

## Scope

- A `run_evals` table and `RunEvalResult` domain type.
- A fourth worker queue and an eval job handler: resolve artefact, one judge call, store result.
- Two API routes: create eval for a run, list evals for a run.
- A fourth task-page tab, **Evaluation**, with a new `RunEvalPanel` component.

## Out of scope

- **A/B comparison against a bare run** (issue #69's with/without experiment). This scores one
  run against its own prompt; the per-layer breakdown is the bridge to #69, not a substitute.
- **Automatic evals on run completion.** Manual button only.
- **Configurable judge model.** The worker's default model grades; the card records which.
- **Comparison UI across eval cards.** History is listed, never diffed.
- **Retention/pruning.** Same stance as `prompt_segments` and `workspace_snapshot`: keep
  everything until row growth is a demonstrated problem.
- **Grading platform-authored segments.** Preamble, environment, and repo map are our own
  boilerplate; scoring the agent against them measures nothing about the team's context.

## Design decisions

- **Evals live in their own table, never on `Run`.** A run can be evaluated more than once
  (e.g. after the judge prompt improves), and the task page polls run status on a timer —
  the `workspaceSnapshot` over-fetch mistake is not being repeated a third time.
- **Only human-authored layers are judged:** `team_context` and `agent_system_prompt`. The
  result groups verdicts by `segmentId` so the UI can answer "which layer earns its bytes."
- **The artefact rule is explicit and recorded.** If the run committed changes, the judge grades
  the branch diff; otherwise it grades the run's final message from the event log. The card
  stores `artefactKind` so no score is ever ambiguous about what it graded. If the intended
  artefact cannot be fetched (branch gone), the eval **fails — it never silently falls back**
  to the other artefact; a score that quietly graded the wrong document is the worst output
  this feature can produce.
- **One judge call, two jobs, structured output.** The call first extracts the checkable
  requirements from the human layers (aspirational text like "write good code" is skipped, not
  failed), then verdicts each against the artefact with a quoted line of evidence. The response
  is forced into the `RunEvalResult` shape by the API's structured-output mode — it parses or
  the eval fails cleanly; there is no hand-rolled parsing of model prose.
- **`unclear` is a real verdict, and it does not score.** A judge pretending certainty is worse
  than one admitting it. An unclear usually means the requirement never applied to this artefact
  at all — "no raw SQL" has nothing to say about a release-notes document — so counting it as a
  miss would grade an agent on the breadth of its team context rather than on its work. Unclears
  are excluded from both sides of the score and stay on the card with their evidence, which is
  where the signal about how checkable the context is actually belongs.
- **Zero checkable requirements is a valid result, not an error.** It means the context contains
  nothing enforceable — worth knowing, plainly stated on the card.
- **The judge model is stamped on every card** (`judge_model_id`): scores from different judges
  are not comparable, so the card must say who graded it.
- **Evals get their own queue.** In the run queue they would wait behind ~60s agent runs;
  grading should start when the user clicks, not when the current run finishes.
- **Every failure ends as a `failed` card with one plain sentence** (machine-readable reason,
  i18n-mapped in the UI). Nothing vanishes; the button returns for retry.

## Mechanism

### Types (`packages/core/src/domain.ts`)

```ts
type EvalStatus = "queued" | "running" | "done" | "failed";
type EvalVerdict = "pass" | "fail" | "unclear";
type EvalArtefactKind = "diff" | "final_message";

interface EvalRequirement { text: string; verdict: EvalVerdict; evidence: string }
interface EvalLayerResult { segmentId: string; requirements: EvalRequirement[] }
interface RunEvalResult {
  artefactKind: EvalArtefactKind;
  layers: EvalLayerResult[];
  score: number; // passed / decided requirements (unclear excluded), 0..1; 0 when none decided
}
```

### Storage (`packages/db/src/schema.ts`)

`run_evals`: `id`, `org_id`, `run_id` (FK → runs), `status` (`eval_status` enum),
`result` (jsonb `RunEvalResult`, null until done), `judge_model_id` (text),
`error` (text, machine-readable reason code, null unless failed), `created_at`,
`completed_at`. Repository: create, transition status, complete-with-result,
fail-with-reason, list-by-run (newest first), all org-scoped.

### Queue (`packages/queue`)

Fourth queue `eval` with job data `{ evalId }`, alongside the existing three. Same connection,
same stale-job story as the run queue.

### Worker (`apps/worker`)

Eval handler, in order:

1. Load eval + run. If `runs.prompt_segments` is null → fail: `run_never_composed_prompt`.
2. Select the human-authored segments (`team_context`, `agent_system_prompt`, non-empty text).
   If none → fail: `no_human_context`.
3. Resolve the artefact: run committed → fetch branch diff against the session's base;
   otherwise → final assistant message from run events. Unfetchable → fail:
   `artefact_unavailable`.
4. One structured-output judge call with the segments and the artefact. Provider errors reuse
   the existing error surfacing (incl. the #99 out-of-credits message).
5. Store `RunEvalResult` + `judge_model_id`, mark `done`, timestamp.

### API (`apps/web/src/app/api`)

- `POST /api/runs/[runId]/evals` — guards: run exists in caller's org, run is in a terminal
  status. Creates the `queued` row, enqueues, returns the eval.
- `GET /api/runs/[runId]/evals` — list for the panel; fetched when the tab opens and polled
  (existing poll pattern) only while an eval is `queued`/`running`.

### UI (`apps/web`)

Fourth tab **Evaluation** on the task page, next to Context. New `RunEvalPanel` component
modelled on `RunContextPanel`; all strings via i18n. States:

- No eval: one-line explanation + **Evaluate** button (disabled with a stated reason when the
  run is not terminal or has no stored prompt).
- Queued/running: the run's existing status treatment, "Evaluating…".
- Done: headline "N of M instructions followed" + which artefact was graded; collapsible
  per-layer groups with ✓ / ✗ / unclear per requirement and the evidence quote.
- Failed: the one-sentence reason + the button again.
- History: newest card open, older cards collapsed beneath, each stamped with time and judge
  model.

### Tests

- **Unit (worker):** artefact resolution (diff vs message, refuse-to-fall-back), segment
  selection, judge-response validation — judge mocked at the single call-site function.
- **DB:** `run_evals` repository lifecycle + org scoping, beside the runs repository tests.
- **Component:** `RunEvalPanel` in all five states.
- **E2E:** finished run → Evaluate → card renders, judge stubbed at the API boundary.
- Grading *quality* is explicitly not asserted in CI.
