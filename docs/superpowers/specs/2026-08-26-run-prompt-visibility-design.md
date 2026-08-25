# Run prompt visibility — design spec

**Date:** 2026-08-26
**Status:** approved

## Problem

Every run composes a system prompt from five pieces — platform preamble, environment brief, team shared context, repo map, agent system prompt (`apps/worker/src/prompt-composition.ts` `composeSystemPrompt`, called from `apps/worker/src/worker.ts:184`) — sends it to the model, and discards it. Only a SHA-256 hash survives (`runs.prompt_hash`), which no human can read.

The consequence: when an agent's output violates a team standard, there is no way to tell whether the standard reached the agent, reached it buried under 80 KB of other text, or was silently dropped (e.g. the agent had no team, so `teamContextPrefix` was `""`). The `context_included` run event records only `included: true` and a 150-character preview — it proves the text was *sent*, never *what* was sent or *why something wasn't*.

Users can already add context (team shared context, repo maps). The next step in making that context effective is being able to see, per run, exactly what the agent was told. This spec is deliberately step A of a three-step arc:

- **A. See it** — store and display the exact prompt each run received (this spec).
- **B. Prove it** — measure whether context changes output quality (future, needs eval harness).
- **C. Force it** — restructure the prompt so context is reliably applied (future, guesswork until A exists).

## Goal

Persist every run's assembled system prompt as an ordered list of labeled segments, guaranteed byte-identical to what the model received, and surface it in a **Context** tab on the task page — including explicit "this layer was omitted, and here's why" rows for layers that contributed nothing.

## Ground truth this design relies on

- **The prompt is composed host-side in one place**: `composeSystemPrompt(environment, teamContextPrefix, repoMap, agentSystemPrompt)` in `prompt-composition.ts`, prefixing `PLATFORM_PREAMBLE`. All five pieces exist as separate strings at `worker.ts:184` and are discarded after concatenation.
- **`runs` already stores large per-run JSON**: `workspaceSnapshot` (jsonb, whole workspace as path→content). A prompt blob (~80 KB worst case: 64 KB shared-context cap + 16 KB repo-map cap + ~2 KB fixed text) is smaller than a typical snapshot, so a jsonb column on `runs` follows existing precedent.
- **`updateRunStatus(runId, "running", { promptHash })` already writes to the run row at exactly the moment the prompt exists** (`worker.ts:185`) — the segment write can ride the same call, no extra round trip.
- **The task page is the real run-transcript surface.** `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` already has a Transcript/Files tab bar, already loads runs and events, and already renders the `context_included` badge. The `/sessions/[sessionId]` page is the older chat mock.
- **The task page polls `/api/runs/[runId]` on a timer while a run is live**, and `getRunsForSession`/`getRun` (`packages/db/src/repositories/runs.ts`) select every column — including `workspaceSnapshot`. Anything added to the `Run` type rides every poll tick.
- **More prompt layers are already planned**: task-linked context and retrieved chunks (docs/PRODUCT-DEFINITION.md §6, layers 2–3), plus a skills index (ARCHITECTURE.md §3). The stored shape must absorb new layers without migration.
- **All user-facing strings go through `useTranslation()`** typed against `en.ts` (CLAUDE.md).

## Scope

- `packages/core/src/domain.ts` — new `PromptSegment` and `RunPrompt` types.
- `apps/worker/src/prompt-composition.ts` — `composeSystemPrompt` returns `{ segments, prompt }` instead of a bare string.
- `packages/db/src/schema.ts` — new nullable `runs.prompt_segments` jsonb column.
- `packages/db/src/repositories/runs.ts` — `updateRunStatus` patch gains `promptSegments`; new `getRunPrompt(runId)` read that selects only the segments column. `toRun` is **not** extended — segments never appear on `Run`.
- `apps/worker/src/worker.ts` — build the segment list (with `omittedReason` for skipped layers), store it alongside `promptHash`.
- `apps/web/src/app/api/runs/[runId]/prompt/route.ts` (new) — returns the run's segments; 404-equivalent empty response when null.
- `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` — new **Context** tab; fetches the prompt lazily on first open.
- `apps/web/src/lib/i18n/dictionaries/en.ts` — segment labels (keyed by segment id) and tab strings.
- Tests: `apps/worker/src/__tests__/prompt-composition.test.ts` extended (join invariant, omission reasons); `packages/db/src/__tests__/repositories/runs.test.ts` extended if present, else covered by the repository read/write round-trip in worker tests.

## Out of scope

- **Any change to prompt content or ordering.** The model receives byte-for-byte what it receives today; this spec only records it.
- **Measuring whether the agent followed the context** (step B) or restructuring the prompt to enforce it (step C).
- **The unbuilt context layers** — task-linked attachments, retrieved chunks, skills index. The segment array is shaped so they slot in later; none are built here.
- **Fixing `getRun`/`getRunsForSession` over-fetching `workspaceSnapshot` on every poll.** Pre-existing issue, flagged separately; this design avoids making it worse but does not fix it.
- **Retention/pruning of stored prompts.** Same stance as `workspaceSnapshot` and `repo_maps`: keep everything until row growth is a demonstrated problem.
- **The old `/sessions/[sessionId]` page.** Untouched.

## Design decisions

- **One source of truth: the stored segments *are* the sent prompt.** `composeSystemPrompt` returns `{ segments, prompt }` where `prompt` is exactly `segments.map(s => s.text).join("")`. There is no second code path that could drift; a stored record that can disagree with what was sent is worse than none. A test asserts the join invariant.
- **Ordered array of generic segments, not a fixed five-field object.** `{ id, text, omittedReason? }`. Adding a future layer (task context, retrieved chunks, skills) is an array insert — no migration, no UI change; the tab renders whatever it's given, in order. Labels come from i18n keyed on `id`, keeping segment ids out of user-facing copy.
- **`omittedReason` is recorded by the worker, which is the only place that knows why.** An empty team-context segment is ambiguous — no team vs. team with a blank context box — and those are different bugs. Omitted segments are stored with `text: ""` and a machine-readable reason code (i18n-mapped in the UI), e.g. `no_team`, `empty_shared_context`, `no_codebase`, `repo_map_pending`.
- **Segments live in their own column and their own type — never on `Run`.** The task page polls run status on a timer; putting ~80 KB on the `Run` type would ship it on every tick (the `workspaceSnapshot` mistake, repeated). A field that isn't on the object can't leak. Reads go through a dedicated `getRunPrompt` selecting only that column, exposed at `GET /api/runs/[runId]/prompt`, fetched only when the Context tab opens.
- **Write rides the existing `updateRunStatus` call at `worker.ts:185`.** The segments and the hash describe the same string and are computed at the same moment; storing them in the same statement means they can never describe different prompts.
- **`agents.systemPrompt` is stored in full, never truncated.** It is the one uncapped input, but a truncated record reintroduces exactly the "can't trust what you're reading" problem this spec exists to remove. Every other layer is already capped upstream (64 KB shared context, 16 KB repo map).
- **Null column = "run never composed a prompt".** Runs that fail before composition (clone failure, credential failure) keep `prompt_segments` null; the tab states that plainly instead of showing an empty list. This distinction is itself diagnostic.
- **`prompt_hash` stays.** It remains the cheap equality check ("did these two runs get the same prompt?") and now has a readable counterpart. The hash shown in the raw view lets anyone verify the stored record against the run row.

## Mechanism

### Types (`packages/core/src/domain.ts`)

```ts
// Why a given prompt layer contributed nothing to this run. Machine-readable;
// the web app maps codes to i18n strings. Unknown codes render as a generic
// "not included" — adding a code is never a breaking change.
export type PromptOmissionReason =
  | "no_team"
  | "empty_shared_context"
  | "no_codebase"
  | "repo_map_pending";

export interface PromptSegment {
  // Stable layer id ("platform_preamble" | "environment" | "team_context" |
  // "repo_map" | "agent_system_prompt" today; future layers append new ids).
  // Typed as string so old clients render new layers without a core bump.
  id: string;
  // The exact text this layer contributed. "" when omitted.
  text: string;
  omittedReason?: PromptOmissionReason;
}

export interface RunPrompt {
  runId: ID;
  segments: PromptSegment[];
  promptHash: string;
}
```

### Composition (`apps/worker/src/prompt-composition.ts`)

```ts
export interface ComposedPrompt {
  segments: PromptSegment[];
  prompt: string; // invariant: segments.map(s => s.text).join("")
}

export function composeSystemPrompt(
  environment: string,
  teamContext: PromptSegment,   // caller supplies text or omittedReason
  repoMap: PromptSegment,
  agentSystemPrompt: string,
): ComposedPrompt
```

The function builds the five segments in the existing order (preamble, environment, team context, repo map, agent prompt) and derives `prompt` from them. Callers that only need the string use `.prompt`; nothing else changes downstream. The environment and preamble segments never carry `omittedReason` — they are unconditional.

`worker.ts` constructs the two conditional segments:

- Team context: `{ id: "team_context", text: teamContextPrefix }`, or `text: ""` with `omittedReason: "no_team"` (agent has no `teamId`) / `"empty_shared_context"` (team exists, formatted context is empty).
- Repo map: `{ id: "repo_map", text: repoMap }` (already wrapped in its heading), or `""` with `"no_codebase"` (chat-only session) / `"repo_map_pending"` (cache miss — generation deferred).

### Storage (`packages/db/src/schema.ts`)

```ts
// The exact system prompt this run's turn received, as ordered labeled
// segments (see PromptSegment). Null until the run composes a prompt — and
// permanently null for runs that fail before that point, which is itself
// diagnostic. Follows the workspaceSnapshot precedent for large per-run jsonb.
promptSegments: jsonb("prompt_segments").$type<PromptSegment[]>(),
```

`updateRunStatus`'s patch type gains `promptSegments?: PromptSegment[]`; the existing `worker.ts:185` call becomes:

```ts
await updateRunStatus(runId, "running", { promptHash: hashPrompt(composed.prompt), promptSegments: composed.segments });
```

New read, deliberately narrow:

```ts
export async function getRunPrompt(id: number): Promise<RunPrompt | undefined> {
  // Selects only promptSegments + promptHash — never the full row, so this
  // can't grow into another every-column poll payload.
}
```

Returns `undefined` when the run doesn't exist **or** `promptSegments` is null; the route maps both to `{ segments: null }` with 200 (the tab distinguishes "no prompt recorded" from transport errors).

### API (`apps/web/src/app/api/runs/[runId]/prompt/route.ts`)

`GET` — auth-gated like the existing `runs/[runId]` route, returns `RunPrompt` or `{ segments: null }`. No caching concerns: segments are immutable once written.

### UI (`apps/web/src/app/(app)/tasks/[taskId]/page.tsx`)

A third `TabBtn` — **Context** — after Transcript and Files, always visible once a session exists (unlike Files it should appear even when empty, because "nothing recorded" is a finding).

Tab content, per selected run (newest first; a compact run picker when the session has multiple runs — reusing the run list already fetched for the transcript):

1. **Layer list** — one row per segment, in stored order: i18n label, byte count, percent of total prompt bytes, expand caret revealing the text in a scrollable monospace block. Omitted layers render greyed with the i18n string for their reason code (e.g. "Team context — not included: agent has no team") and no caret.
2. **Raw toggle** — joins segment texts client-side and shows the exact string plus `promptHash`, so the on-screen text is verifiably the stored record.
3. **Null state** — "No prompt was recorded for this run — it failed before composing one."

Fetching is lazy: `GET /api/runs/[runId]/prompt` fires on first tab open (and on run-picker change), cached in component state per runId. The tab never joins the polling loop.

Design goal for the whole tab: a tech lead who wrote a coding standard can open a run and answer "did my standard reach the agent, and how much of the prompt did it occupy?" in about three seconds.

### Tests

- **Join invariant** (`prompt-composition.test.ts`): for representative inputs (all layers present; team context omitted; repo map omitted; both omitted), `composed.prompt === composed.segments.map(s => s.text).join("")`, and the prompt is byte-identical to what the pre-change implementation produced for the same inputs.
- **Omission plumbing**: worker-level test that a no-team agent stores a `team_context` segment with `omittedReason: "no_team"` and empty text.
- **Read/write round trip**: segments written via `updateRunStatus` come back via `getRunPrompt`; a run without segments returns `undefined`; `getRunPrompt` result carries the matching `promptHash`.
- **Route**: auth-gated; null column maps to `{ segments: null }`.

## Follow-ups (explicitly not this spec)

- Fix `getRun`/`getRunsForSession` selecting `workspaceSnapshot` on every status poll.
- Step B: eval harness comparing runs with/without context layers.
- Step C: prompt restructuring informed by what A reveals.
- Surface a live size-budget preview in the team shared-context editor.
