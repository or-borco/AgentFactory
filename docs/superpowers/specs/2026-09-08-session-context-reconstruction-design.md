# Session context reconstruction on sandbox loss — design spec

**Date:** 2026-09-08
**Status:** approved

## Problem

A session's `resume` continuity is silently broken by idle-sandbox reaping (or any other sandbox teardown), and the break is permanent — the session never self-heals.

This is not hypothetical: T-067's session (id 27) ran once successfully on 2026-09-04, recording `providerSessionRef = "40d5d504-..."` on that run. The session then sat idle for three days — well past the 2-hour idle threshold (`docs/superpowers/specs/2026-09-02-idle-sandbox-reaping-design.md`) — so its sandbox was torn down. On 2026-09-07 a follow-up reply arrived; `ensureSandbox` (`apps/worker/src/worker.ts:75-85`) transparently provisioned a *new* container, but the worker still passed `resume: "40d5d504-..."` to it (`getLatestProviderSessionRef`, `packages/db/src/repositories/runs.ts:123-134`, just returns the most recent non-null ref with no liveness check). The Claude Agent SDK's `resume` mechanism is local to a container's filesystem, not server-side — the new container has never heard of that conversation, so the run failed immediately: `error_during_execution (No conversation found with session ID: ...)`.

Because the failed run never got far enough to record its own `providerSessionRef`, the *next* reply inherited the exact same stale ref and failed identically. Three consecutive replies (runs 49, 50, 51) failed the same way over two days. The session is now permanently stuck — every future message to it will fail forever, since nothing ever overwrites the broken pointer.

The idle-sandbox-reaping design's own stated assumption — "`ensureSandbox` already recreates and re-clones on demand, so the only cost of tearing down an idle-but-not-abandoned sandbox is a slower next run, not lost work" — is false along this one dimension. The code changes survive fine (already pushed to the session's git branch); the *conversation* does not.

## Goal

When a session's sandbox has been recreated since its last `providerSessionRef` was established, the next run reconstructs enough prior-turn context from the session's own message history to continue coherently, instead of attempting (and failing) to resume a conversation that no longer exists anywhere.

## Ground truth this design relies on

- **A session has exactly one sandbox at a time**, tracked as `sessions.sandboxId` (`packages/db/src/schema.ts`). `ensureSandbox` (`apps/worker/src/worker.ts:75-85`) already contains the exact signal this design needs: it returns the existing id unchanged when the container still exists, and only calls `setSessionSandboxId` with a new value when it has to create one. No new schema is needed — comparing "sandboxId before the call" to "sandboxId after the call" in the caller is sufficient.
- **`getLatestProviderSessionRef(sessionId, excludeRunId)` (`packages/db/src/repositories/runs.ts:123-134`) has no concept of sandbox liveness.** It is a pure "most recent non-null ref for this session" query, by design — it has no reason to know about sandboxes today.
- **`messages` already holds the session's full user/assistant turn history**, one row per turn (`packages/db/src/repositories/messages.ts`). `createMessage(sessionId, "assistant", text, runId)` is only called on a run's success path (`apps/worker/src/worker.ts`, right after the agent turn returns), so a failed run leaves only its triggering user message recorded — gaps included, same as today.
- **`composeSystemPrompt` (`apps/worker/src/prompt-composition.ts:196-212`) assembles the system prompt from an ordered, empirically-tuned list of `PromptSegment`s**, each built by a small `buildXSegment` helper (`buildTeamContextSegment`, `buildRepoMapSegment`, `buildRetrievedContextSegment`). The ordering is not incidental — it's backed by a measured experiment (`docs/superpowers/experiments/2026-08-26-prompt-layer-ordering.md`) showing that human-authored instructions (team context, the agent's own system prompt) must go *last*, after platform-authored facts and machine-selected reference material, or instruction-following measurably degrades.
- **`runs.promptSegments`/`promptHash` persist exactly what was sent** (`updateRunStatus(runId, "running", { promptHash, promptSegments })`, `apps/worker/src/worker.ts`), and `RunContextPanel` in the web UI renders those segments for a human to audit what a run actually saw. Anything added as a `PromptSegment` gets this transparency for free; anything folded into `userText` instead does not.
- **`PromptOmissionReason` (`packages/core/src/domain.ts:294-309`) is a closed union** the UI already knows how to render generically for unrecognized codes — adding a new reason to it is non-breaking.

## Scope

- `apps/worker/src/worker.ts` — capture `session.sandboxId` before `ensureSandbox`, compare after; skip `getLatestProviderSessionRef` and `resume` when the sandbox was recreated; fetch and pass prior-conversation history instead.
- `apps/worker/src/prompt-composition.ts` — new `buildPriorConversationSegment` helper; `composeSystemPrompt` gains one more segment parameter.
- `packages/core/src/domain.ts` — `PromptOmissionReason` gains two new values: one for "sandbox wasn't recreated, segment doesn't apply" and one for "recreated, but nothing to reconstruct" (first-ever run on a session).
- `packages/db/src/repositories/messages.ts` — reuse the existing `listMessages(sessionId)`; no new query needed.

## Out of scope

- **Reconstructing anything beyond conversation text.** Code changes already survive independently via git (the session's branch is pushed after every run that commits). This design is only about restoring the *model's* memory of what was already discussed and decided, not about restoring any other state.
- **True summarization** (an extra model call to compact history into a synopsis). Bounded raw inclusion, oldest-first truncation, is enough for the sizes actually seen (a full multi-turn `messages` history for a task like T-067 is a handful of KB, not hundreds) and adds zero latency/cost to the common case. Revisit if real usage shows conversations that blow the budget routinely.
- **Making the 2-hour idle threshold or the reap sweep itself smarter.** This design fixes what happens *after* a sandbox is gone, not when one goes away. Idle-reap's own timing is unrelated and already covered by its own spec.
- **Self-healing already-stuck sessions retroactively without a new message.** This design fixes the path forward — the next reply to a stuck session reconstructs correctly — not a background sweep that repairs T-067 and similar sessions without anyone messaging them. No such sweep is proposed; the fix applies the moment someone next replies, which is the only time it matters.

## Design decisions

- **Proactive detection, not a catch-and-retry on the SDK's error.** The signal (`sandboxId` changed) is known *before* attempting resume, so there's no reason to spend a full run's worth of provisioning and a failed model call just to discover what a two-line comparison already tells us. This also means the fix is generic to *any* cause of sandbox loss, not just idle-reap specifically (manual teardown, a crash, a host restart) — it doesn't matter why the sandbox is gone, only that it is.
- **Bounded raw inclusion of `messages`, not a summarization pass.** See "Out of scope" above. Keeping this a synchronous, zero-extra-call operation means the reconstruction path costs the same as the normal path, just with a different (and typically smaller) segment in place of `resume`.
- **32 KB budget for the reconstructed segment.** Between the repo map's 16 KB cap and `shared_context`'s 64 KB — a reconstructed conversation is more load-bearing for coherence than either (getting a repo map wrong costs some rediscovery; losing conversational continuity entirely, which is the failure being fixed, is worse), but still needs a hard ceiling so one very long-running session can't blow the whole prompt budget. Truncation drops the **oldest** messages first, keeping the most recent turns intact — those are what the model most needs to pick up where it left off — and the segment says plainly when it has been trimmed.
- **The triggering message for *this* run is excluded from the reconstructed segment.** `listMessages(sessionId)` returns every message including the one that just triggered this exact run (it's created before the run is enqueued — see `apps/web/src/app/api/sessions/[sessionId]/messages/route.ts`). That message is still sent as `userText` the normal way; including it again in the segment would just duplicate it.
- **Segment placement: immediately after `environment`, before `repoMap`.** The reconstructed conversation is platform-observable fact about what already happened — closer in kind to `environment` (also platform-authored, authoritative) than to team-authored instructions or machine-selected reference material. Placing it early, right after the other situational-grounding segment and before the "reference material" segments (repo map, retrieved context), keeps the established ordering principle intact: platform facts first, human instructions last. It does not go *before* `environment`, since `environment` states hard facts about the current sandbox/workspace that the reconstructed history should be read in light of, not the reverse.
- **A `PromptSegment`, not a `userText` prefix.** This costs one more parameter threaded through `composeSystemPrompt` and one more `buildXSegment` helper, but it means the reconstructed context gets the same `RunContextPanel` visibility and `promptHash`/`promptSegments` persistence every other layer already has — a human debugging why a reconstructed run behaved oddly should be able to see exactly what it was told, the same way they can for team context or the repo map today.

## Mechanism

### Trigger (worker.ts)

```ts
// apps/worker/src/worker.ts, replacing the current
// const sandboxId = await ensureSandbox(session);
const hadSandboxId = session.sandboxId;
const sandboxId = await ensureSandbox(session);
const sandboxWasRecreated = sandboxId !== hadSandboxId;
...
const resumeSessionRef = sandboxWasRecreated
  ? undefined
  : await getLatestProviderSessionRef(session.id, runId);
const priorConversation = sandboxWasRecreated
  ? await buildPriorConversationHistory(session.id, run.triggeringMessageId)
  : "";
```

### Segment builder (prompt-composition.ts)

```ts
// apps/worker/src/prompt-composition.ts
const PRIOR_CONVERSATION_BUDGET_BYTES = 32 * 1024;

export function buildPriorConversationSegment(sandboxWasRecreated: boolean, formatted: string): PromptSegment {
  if (formatted) return { id: "prior_conversation", text: formatted };
  return {
    id: "prior_conversation",
    text: "",
    omittedReason: sandboxWasRecreated ? "no_prior_conversation" : "sandbox_not_recreated",
  };
}
```

`sandboxWasRecreated` distinguishes "sandbox wasn't recreated, so this segment legitimately doesn't apply" (`sandbox_not_recreated`) from "sandbox was recreated but this is the session's first-ever run, so there's nothing to reconstruct" (`no_prior_conversation`) — both render as omitted, but for different, auditable reasons, matching the existing pattern for `team_context`/`repo_map`.

### History formatting (worker.ts or a small new helper alongside it)

Reverse-chronological accumulation against the 32 KB budget (keep adding the next-most-recent message while it still fits, stop once it doesn't), then re-reversed back to chronological order for the actual segment text — the most recent turns are what the model most needs, so they're the ones guaranteed to survive truncation. Each turn renders as a labeled `User:`/`Assistant:` line pair, wrapped in the same heading + trailing-separator convention `formatSharedContextForPrompt` and the repo-map segment already use, so it reads unambiguously as prior dialogue rather than platform-authored instruction:

```
## Prior Conversation (reconstructed — the sandbox that held this conversation's state was
reclaimed; this is the message history so far)

User: ...
Assistant: ...

[earlier messages omitted for length]

---

```

### composeSystemPrompt (prompt-composition.ts)

```ts
export function composeSystemPrompt(
  environment: string,
  priorConversation: PromptSegment,
  teamContext: PromptSegment,
  repoMap: PromptSegment,
  retrievedContext: PromptSegment,
  agentSystemPrompt: string,
): ComposedPrompt {
  const segments: PromptSegment[] = [
    { id: "platform_preamble", text: PLATFORM_PREAMBLE },
    { id: "environment", text: environment },
    priorConversation,
    repoMap,
    retrievedContext,
    teamContext,
    { id: "agent_system_prompt", text: agentSystemPrompt },
  ];
  return { segments, prompt: segments.map((s) => s.text).join("") };
}
```

### domain.ts

```ts
export type PromptOmissionReason =
  | "no_team"
  | "empty_shared_context"
  | "no_codebase"
  | "repo_map_pending"
  | "no_indexed_documents"
  | "no_relevant_chunks"
  | "retrieval_failed"
  | "no_context_sources"
  | "no_prior_conversation" // sandbox was recreated, but this is the session's first-ever run
  | "sandbox_not_recreated"; // segment legitimately doesn't apply this run
```

## Testing

- **worker test**: given a session whose returned `sandboxId` differs from its stored one, assert `resumeSessionRef` is `undefined` and `getLatestProviderSessionRef` is never called; given an unchanged `sandboxId`, assert today's behavior (resume attempted, no history fetch) is unchanged.
- **worker test**: reproduce T-067's exact shape — a session with one successful run's messages, then a "sandbox recreated" run — and assert the reconstructed segment contains that prior turn's text, excludes the new triggering message, and is well-formed.
- **prompt-composition test** for `buildPriorConversationSegment`: empty history → `no_prior_conversation`; sandbox not recreated → `sandbox_not_recreated`; content present → included verbatim; content exceeding 32 KB → oldest messages dropped, most recent retained, trim note present.
- **db-integration test** (if needed): confirm `listMessages` ordering is chronological (oldest first) so the truncate-then-reverse logic is building on the assumption it actually holds.

## Risks

- **32 KB is an unmeasured starting default**, same category as the idle-reap spec's own 2-hour threshold. Too small and a long-running session loses useful earlier context on reconstruction; too large and it crowds out budget the repo map or retrieved context would otherwise use. Revisit once there's a real reconstructed run to look at.
- **A session that reconstructs, then goes idle again past the threshold, reconstructs again on its next reply** — each reconstruction is independent and doesn't compound (it's always built fresh from `messages`, never from a previous reconstruction), so this is expected and fine, not a growing-context problem.
- **This does not retroactively fix already-stuck sessions like T-067's without a new message arriving.** Acceptable per "Out of scope" — the fix applies going forward, which is the only point at which it can matter.
