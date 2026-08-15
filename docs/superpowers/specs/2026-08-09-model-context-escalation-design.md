# Model context escalation — design spec

**Date:** 2026-08-09
**Status:** approved

## Problem

When a session's resumed conversation history plus system prompt exceeds the assigned model's context window, the Claude Agent SDK rejects the call with `Prompt is too long`. Today this fails the run outright with a generic, unhelpful message (`session.replyFailed` in the UI), and — until a separate fix already applied to `apps/worker/src/worker.ts` — the real error wasn't even logged; the run's `catch` block set the run to `"failed"` and swallowed the actual exception.

This was discovered on a real task (T-166): its first turn produced a large implementation (full file dumps + two markdown docs), and it's assigned `claude-haiku-4-5`. Every follow-up in that session resumes the same growing transcript, so the accumulated prompt eventually overflows Haiku's context window.

## Goal

When a run would overflow its assigned model's context window, automatically retry the same turn on a larger-context model in the same family, so the run succeeds instead of failing — while keeping this behavior visible (event log) and auditable (persisted on the run), and opt-outable per agent.

## Scope

- General architecture, not a one-off fix for T-166: applies to any agent/task/model combination.
- Reactive detection (catch the actual SDK overflow error and retry bigger) — not proactive token estimation. The model's own limit is ground truth; a heuristic token count can be wrong.
- Escalation ladder: `claude-haiku-4-5 → claude-sonnet-5 → claude-opus-5`. Escalates all the way to the top tier if needed — reliability over cost, since this is a rare/edge-case path, not the common one.
- `claude-fable-5` is excluded from the ladder entirely (distinct/specialized model, not simply bigger or smaller). An agent pinned to Fable that overflows fails fast — there's nothing to escalate to.
- Per-agent policy: `onContextOverflow: "fallback" | "fail_fast"`, default `"fallback"`. Existing agents get `"fallback"` via column default — no behavior change until this case is actually hit.

## Out of scope (deferred)

- Proactive token-budget estimation or UI warnings before a turn is attempted.
- A configurable fallback ceiling (e.g. "escalate at most one tier").
- Trimming or summarizing old session history to fit a smaller model.
- Surfacing a distinct user-facing chat bubble message for this specific failure mode (vs. the existing generic `session.replyFailed`) when the ladder is exhausted — the event log makes the real reason visible for now; a nicer top-level message is a follow-up.

## Data model changes

### `packages/core/src/models.ts`

Detection is reactive (see below), not based on comparing token counts to a window size, so no `contextWindow` data is needed — only ordering. Add an explicit escalation ladder:

```ts
// Explicit list, not derived from MODEL_CATALOG order — keeps Fable's exclusion a deliberate
// fact in the data rather than an accident of catalog ordering.
const ESCALATION_LADDER = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"] as const;

export function nextEscalationTier(modelId: string): string | undefined {
  const index = ESCALATION_LADDER.indexOf(modelId as (typeof ESCALATION_LADDER)[number]);
  if (index === -1 || index === ESCALATION_LADDER.length - 1) return undefined;
  return ESCALATION_LADDER[index + 1];
}
```

### `packages/core/src/events.ts`

New event, following the existing `PolicyDecisionEvent` convention:

```ts
export interface ModelEscalatedEvent extends RunEventBase {
  type: "model_escalated";
  fromModel: string;
  toModel: string;
  reason: "context_overflow";
}
```

Add `ModelEscalatedEvent` to the `RunEvent` union.

### `packages/db/src/schema.ts`

Two additions:

1. `runs.model: jsonb("model").$type<ModelSpec>()` — the `ModelSpec` that actually executed the turn. Today nothing persists this; the model is computed at run time from agent/task and discarded. Needed so an escalated run is a queryable fact (cost accounting, audit) and not just a transcript line.
2. `agents.onContextOverflow: text("on_context_overflow", { enum: ["fallback", "fail_fast"] }).notNull().default("fallback")`.

Both require a migration (`packages/db/drizzle/00XX_*.sql` + regenerated meta snapshot).

### `packages/db/src/repositories/runs.ts`

`updateRunStatus` (or a new dedicated call site in the escalation loop) needs to accept and persist `model` when a run reaches `"done"` or `"failed"`, reflecting whichever tier actually ran.

### `packages/db/src/repositories/agents.ts`

Thread `onContextOverflow` through agent create/update/read, same as any other agent config field.

## Detection mechanism

The overflow error originates *inside* the Claude Agent SDK's `query()` async generator (confirmed by reproducing it: `Error: Claude Code returned an error result: Prompt is too long`, thrown from `sdk.mjs`'s `readMessages`), not from our own code. It propagates directly out of the `for await` loop in `apps/worker/sandbox-image/run-turn.ts`, straight to that file's top-level `.catch`, which today just does `console.error(err); process.exit(1)` — collapsing it into the same undifferentiated stderr blob as every other failure.

**`run-turn.ts` changes:** wrap the `for await (const message of query(...))` loop in try/catch. If the caught error's message matches the SDK's overflow signature, write a new sentinel line to stdout before exiting — consistent with the file's existing `__RESULT__`/`__EVENT__` marker convention:

```
__ERROR__{"code":"prompt_too_long"}
```

Any other error falls through to the existing generic `console.error` + exit path unchanged.

**`apps/worker/src/agent-runtime.ts` changes:** `runAgentTurn` checks the collected stdout for the `__ERROR__` marker *before* checking for `__RESULT__`. If found and `code === "prompt_too_long"`, throw a new typed `PromptTooLongError` (a plain `Error` subclass) instead of the generic `Error("Sandbox run produced no result line...")`. This is the signal the retry loop keys off — everything else remains a generic failure, so unrelated errors never trigger escalation.

## Escalation flow

`runAgentTurn`'s workspace-clone step (`cloneIntoSandbox`, currently run unconditionally at the top of the function) must happen once per job, not once per escalation attempt — re-cloning on every retry would be wasteful. To keep this cleanly testable and avoid re-cloning, the retry loop wraps only the model-call portion:

New module `apps/worker/src/model-escalation.ts` — pure, no I/O, easily unit-testable:

```ts
export type OverflowPolicy = "fallback" | "fail_fast";

// Returns the model to retry with, or undefined if escalation should stop (policy is
// fail_fast, or the ladder is exhausted).
export function resolveEscalation(currentModelId: string, policy: OverflowPolicy): string | undefined {
  if (policy === "fail_fast") return undefined;
  return nextEscalationTier(currentModelId);
}
```

`apps/worker/src/worker.ts`'s job processor wraps the existing `runAgentTurn` call in a loop:

```
attempt = assigned model
loop:
  try runAgentTurn(..., model: attempt)
  on success: persist runs.model = attempt, done
  on PromptTooLongError:
    next = resolveEscalation(attempt.id, agent.onContextOverflow)
    if next is undefined: rethrow (existing catch-all failure path handles it)
    emit ModelEscalatedEvent(from: attempt, to: next, reason: "context_overflow")
    attempt = next model spec, continue loop
  on any other error: rethrow immediately (unchanged behavior)
```

The workspace clone stays outside this loop (called once, before it, as today).

## Testing

- **`packages/core`**: unit tests for `nextEscalationTier` — correct ordering, `undefined` past the top of the ladder, `undefined`/no-entry behavior for `claude-fable-5`.
- **`apps/worker/agent-runtime`**: unit tests feeding fake sandbox stdout containing `__ERROR__{"code":"prompt_too_long"}` vs. other stdout/stderr combinations, asserting `PromptTooLongError` is thrown only for the former.
- **`apps/worker/model-escalation`**: unit tests for `resolveEscalation` — fallback policy walks the ladder, fail_fast always stops, exhausted ladder returns `undefined`.
- **`packages/db` repositories**: extend `packages/db/src/__tests__/repositories/messages-runs-events.test.ts` to cover persisting `runs.model`; extend `agents.test.ts` to cover `onContextOverflow` read/write and its default.

`worker.ts`'s job processor itself is not directly unit tested (consistent with the existing codebase — it's BullMQ wiring); the escalation *decision* logic it calls into is fully covered by `model-escalation.test.ts`, which is where the actual branching logic lives.

## UI

Not in this slice beyond what's needed for the policy field to exist:
- Agent settings form gets an `onContextOverflow` control (fallback/fail-fast), same section as the agent's default model.
- No changes to the task chat UI's failure messaging — `ModelEscalatedEvent` is visible via the existing events/transcript view, but the generic `session.replyFailed` text is unchanged for the terminal-failure case.

## Implementation plan / PR split

~6 files per PR, in dependency order:

1. **Domain & schema** — `packages/core/src/models.ts` (+ test), `packages/core/src/events.ts`, `packages/db/src/schema.ts` + migration, `packages/db/src/repositories/runs.ts`, `packages/db/src/repositories/agents.ts`.
2. **Escalation logic** — `apps/worker/sandbox-image/run-turn.ts`, `apps/worker/src/agent-runtime.ts` (+ test), `apps/worker/src/model-escalation.ts` (+ test), `apps/worker/src/worker.ts` wiring.
3. **Persistence tests + UI** — `messages-runs-events.test.ts` and `agents.test.ts` updates, agent settings API routes, agent settings form field, i18n strings.
