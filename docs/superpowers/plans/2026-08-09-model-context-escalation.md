# Model Context Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a run's resumed session history overflows its assigned model's context window, automatically retry on a larger-context model instead of failing the run.

**Architecture:** Detection is reactive — `apps/worker/sandbox-image/run-turn.ts` catches the Claude Agent SDK's own "Prompt is too long" error and signals it via a new stdout sentinel; `apps/worker/src/agent-runtime.ts` turns that into a typed `PromptTooLongError`; `apps/worker/src/worker.ts` retries the turn up an explicit escalation ladder (`claude-haiku-4-5 → claude-sonnet-5 → claude-opus-5`), governed by a new per-agent `onContextOverflow` policy, emitting a `model_escalated` event on every hop.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), BullMQ, Vitest, Next.js App Router.

## Global Constraints

- Detection is reactive (catch the SDK's actual overflow error), never proactive token estimation — the spec's explicit choice, since the model's own limit is ground truth.
- Escalation ladder is exactly `claude-haiku-4-5 → claude-sonnet-5 → claude-opus-5`. `claude-fable-5` is excluded — never a source or target of escalation.
- Escalation can walk the full ladder to the top tier (no configurable ceiling in this slice).
- Per-agent policy `onContextOverflow: "fallback" | "fail_fast"`, default `"fallback"`. Existing agents must be unaffected — the DB column default handles this, not application code.
- No approval gates: escalation retries happen automatically inside the run, never pausing for human input (existing project-wide rule, `CLAUDE.md`).
- Every task follows TDD: write the failing test first, watch it fail, implement, watch it pass.
- Don't touch `apps/web/src/server/mock-store.ts` or any other still-mock domain — agents/runs are already real (DB-backed via `@agentfactory/db`), confirmed during design.

---

## PR 1 — Escalation ladder & event type (`packages/core`)

**Files touched:** `packages/core/src/models.ts`, `packages/core/src/__tests__/models.test.ts`, `packages/core/src/events.ts` (3 files)

### Task 1: Escalation ladder in `packages/core/src/models.ts`

**Files:**
- Modify: `packages/core/src/models.ts`
- Test: `packages/core/src/__tests__/models.test.ts` (new)

**Interfaces:**
- Produces: `nextEscalationTier(modelId: string): string | undefined` — exported from `packages/core`, consumed by `apps/worker/src/model-escalation.ts` in Task 8.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/models.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextEscalationTier } from "../models";

describe("nextEscalationTier", () => {
  it("walks up the ladder from haiku to sonnet", () => {
    expect(nextEscalationTier("claude-haiku-4-5")).toBe("claude-sonnet-5");
  });

  it("walks up the ladder from sonnet to opus", () => {
    expect(nextEscalationTier("claude-sonnet-5")).toBe("claude-opus-5");
  });

  it("returns undefined at the top of the ladder", () => {
    expect(nextEscalationTier("claude-opus-5")).toBeUndefined();
  });

  it("excludes fable from the ladder", () => {
    expect(nextEscalationTier("claude-fable-5")).toBeUndefined();
  });

  it("returns undefined for an unknown model id", () => {
    expect(nextEscalationTier("not-a-real-model")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/core/src/__tests__/models.test.ts`
Expected: FAIL — `nextEscalationTier` is not exported from `../models`.

- [ ] **Step 3: Implement `nextEscalationTier`**

In `packages/core/src/models.ts`, add after `DEFAULT_MODEL_ID`:

```ts
// Explicit list, not derived from MODEL_CATALOG order — keeps Fable's exclusion a deliberate
// fact in the data rather than an accident of catalog ordering. Used by the worker's context-
// overflow escalation (apps/worker/src/model-escalation.ts) to find the next larger-context
// model in the same family.
const ESCALATION_LADDER = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"] as const;

export function nextEscalationTier(modelId: string): string | undefined {
  const index = ESCALATION_LADDER.indexOf(modelId as (typeof ESCALATION_LADDER)[number]);
  if (index === -1 || index === ESCALATION_LADDER.length - 1) return undefined;
  return ESCALATION_LADDER[index + 1];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --project unit packages/core/src/__tests__/models.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/models.ts packages/core/src/__tests__/models.test.ts
git commit -m "Add context-overflow escalation ladder to model catalog"
```

### Task 2: `ModelEscalatedEvent` in `packages/core/src/events.ts`

**Files:**
- Modify: `packages/core/src/events.ts`

**Interfaces:**
- Produces: `ModelEscalatedEvent` type and its `"model_escalated"` member on the `RunEvent` union — consumed by `apps/worker/src/worker.ts` in Task 9 (via `createEvent(runId, seq, "model_escalated", {...})`) and by anything reading `RunEvent` (event stream UI).

This is a type-only addition (no runtime logic), verified by typecheck rather than a unit test.

- [ ] **Step 1: Add the event type**

In `packages/core/src/events.ts`, add after `PolicyDecisionEvent`:

```ts
export interface ModelEscalatedEvent extends RunEventBase {
  type: "model_escalated";
  fromModel: string;
  toModel: string;
  reason: "context_overflow";
}
```

Add `ModelEscalatedEvent` to the `RunEvent` union:

```ts
export type RunEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | PolicyDecisionEvent
  | ModelEscalatedEvent
  | ArtifactEvent
  | UsageEvent
  | ErrorEvent
  | DoneEvent;
```

- [ ] **Step 2: Verify with typecheck**

Run: `pnpm --filter @agentfactory/core typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/events.ts
git commit -m "Add model_escalated run event type"
```

---

## PR 2 — Schema, domain types & repositories (`packages/db`)

**Files touched:** `packages/db/src/schema.ts` + migration (2 files), `packages/core/src/domain.ts`, `packages/core/src/models.ts`, `packages/db/src/repositories/agents.ts`, `packages/db/src/__tests__/repositories/agents.test.ts`, `packages/db/src/repositories/runs.ts`, `packages/db/src/__tests__/repositories/messages-runs-events.test.ts` (8 files)

### Task 3: Schema columns + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Generated: `packages/db/drizzle/00XX_*.sql`, `packages/db/drizzle/meta/00XX_snapshot.json`, `packages/db/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `runs.model` (nullable jsonb, `ModelSpec`) and `agents.onContextOverflow` (text enum, not null, default `'fallback'`) columns — consumed by Tasks 4 and 5's repository changes.

No new domain type is referenced here yet (`ModelSpec` is already imported in `schema.ts` for `agents.model`) — this task only touches the Drizzle table definitions and generates the migration. Verified via the DB integration test suite, which runs migrations against a scratch database before every test file.

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema.ts`, add to the `runs` table (after the `workspaceSnapshot` field, around line 213):

```ts
  // The ModelSpec that actually executed this run's turn — may differ from the agent/task's
  // assigned model if context-overflow escalation (worker.ts) bumped it to a larger tier.
  // Null until the run resolves a model (never set for runs that fail before that point).
  model: jsonb("model").$type<ModelSpec>(),
```

Add to the `agents` table (after `connectionIds`, around line 113):

```ts
  // What to do when a run's resumed session history overflows this agent's assigned model's
  // context window. "fallback" (default) escalates up the ladder in packages/core/src/models.ts;
  // "fail_fast" keeps the assigned model fixed and lets the run fail for real.
  onContextOverflow: text("on_context_overflow", { enum: ["fallback", "fail_fast"] })
    .notNull()
    .default("fallback"),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @agentfactory/db db:generate`
This creates a new `packages/db/drizzle/00XX_<generated-name>.sql` and updates `packages/db/drizzle/meta/00XX_snapshot.json` and `packages/db/drizzle/meta/_journal.json`.

- [ ] **Step 3: Verify the generated SQL**

Read the new `.sql` file. It must contain exactly two `ALTER TABLE` statements: one adding `model jsonb` to `runs` (nullable, no default), one adding `on_context_overflow text` to `agents` (`NOT NULL DEFAULT 'fallback'`). If drizzle-kit prompts interactively about the new enum-like column, choose "create column" (not a rename) — there is no prior column this could be confused with.

- [ ] **Step 4: Run the DB integration suite to confirm the migration applies cleanly**

Run: `pnpm test:db`
Expected: PASS — this runs `migrate()` against the scratch database (see `packages/db/src/__tests__/setup.ts`) before any test, so a broken migration fails every test in the suite, not just a new one.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "Add runs.model and agents.on_context_overflow columns"
```

### Task 4: `OverflowPolicy` domain type + `agents` repository

**Files:**
- Modify: `packages/core/src/domain.ts`
- Modify: `packages/core/src/models.ts`
- Modify: `packages/db/src/repositories/agents.ts`
- Test: `packages/db/src/__tests__/repositories/agents.test.ts`

**Interfaces:**
- Consumes: `agents.onContextOverflow` column from Task 3.
- Produces: `OverflowPolicy` type (`packages/core`), `Agent.onContextOverflow: OverflowPolicy` (now a required field on every `Agent`), `isValidOverflowPolicy(value: string): value is OverflowPolicy` (`packages/core/src/models.ts`) — consumed by `apps/web`'s API routes in Task 10 and by `apps/worker/src/model-escalation.ts` in Task 8. `NewAgentInput.onContextOverflow?` and `AgentPatch.onContextOverflow?` (both optional, `packages/db`) — consumed by the same web routes.

- [ ] **Step 1: Write the failing tests**

Add to `packages/db/src/__tests__/repositories/agents.test.ts` (inside the existing `describe("agents repository", ...)` block):

```ts
  it("defaults onContextOverflow to fallback", async () => {
    const org = await insertOrg();
    const agent = await createAgent(org.id, {
      name: "Reviewer",
      description: "",
      systemPrompt: "Be helpful.",
      mode: "manual",
    });
    expect(agent.onContextOverflow).toBe("fallback");
  });

  it("accepts an explicit onContextOverflow on create", async () => {
    const org = await insertOrg();
    const agent = await createAgent(org.id, {
      name: "Strict reviewer",
      description: "",
      systemPrompt: "Be helpful.",
      mode: "manual",
      onContextOverflow: "fail_fast",
    });
    expect(agent.onContextOverflow).toBe("fail_fast");
  });

  it("updates onContextOverflow", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);

    const updated = await updateAgent(agent.id, { onContextOverflow: "fail_fast" });

    expect(updated?.onContextOverflow).toBe("fail_fast");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:db`
Expected: FAIL — `Agent` has no `onContextOverflow` property yet (TypeScript error) and/or `createAgent`/`updateAgent` don't accept it.

- [ ] **Step 3: Add `OverflowPolicy` and update `Agent`/`Run` in `packages/core/src/domain.ts`**

Add near `ModelSpec` (before `export interface Agent`):

```ts
export type OverflowPolicy = "fallback" | "fail_fast";
```

In the `Agent` interface, add after `connectionIds: ID[];`:

```ts
  onContextOverflow: OverflowPolicy;
```

In the `Run` interface, add after `workspaceSnapshot?: Record<string, string>;`:

```ts
  model?: ModelSpec;
```

- [ ] **Step 4: Add `isValidOverflowPolicy` to `packages/core/src/models.ts`**

Add near `isValidModelId`:

```ts
export function isValidOverflowPolicy(value: string): value is OverflowPolicy {
  return value === "fallback" || value === "fail_fast";
}
```

This needs `OverflowPolicy` imported at the top of `models.ts`:

```ts
import type { ModelSpec, OverflowPolicy } from "./domain";
```

(`ModelSpec` is presumably already imported there for `buildModelSpec`'s return type — check the existing import line and extend it rather than duplicating.)

- [ ] **Step 5: Update `packages/db/src/repositories/agents.ts`**

In `toAgent()`, add after `connectionIds: row.connectionIds,`:

```ts
    onContextOverflow: row.onContextOverflow,
```

In `NewAgentInput`, add:

```ts
  onContextOverflow?: OverflowPolicy;
```

(needs `import type { OverflowPolicy } from "@agentfactory/core";` added to the existing `@agentfactory/core` import line.)

In `createAgent`, add to the `.values({...})` call, after `connectionIds: [],`:

```ts
      onContextOverflow: input.onContextOverflow ?? "fallback",
```

In `AgentPatch`, add `"onContextOverflow"` to the `Pick<...>` union:

```ts
export interface AgentPatch
  extends Partial<
    Pick<Agent, "name" | "description" | "systemPrompt" | "mode" | "teamId" | "areaMap" | "defaultCodebase" | "onContextOverflow">
  > {
  model?: string;
}
```

In `updateAgent`, add after the `model` patch handling:

```ts
  if (patch.onContextOverflow !== undefined) values.onContextOverflow = patch.onContextOverflow;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test:db`
Expected: PASS, including the 3 new tests and every pre-existing `agents repository` test (the required field is now populated on every insert path).

- [ ] **Step 7: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: PASS. `Agent` is now a required-field change; this catches any other construction site the earlier search may have missed.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/domain.ts packages/core/src/models.ts packages/db/src/repositories/agents.ts packages/db/src/__tests__/repositories/agents.test.ts
git commit -m "Add per-agent onContextOverflow policy"
```

### Task 5: `runs` repository persists the executed model

**Files:**
- Modify: `packages/db/src/repositories/runs.ts`
- Test: `packages/db/src/__tests__/repositories/messages-runs-events.test.ts`

**Interfaces:**
- Consumes: `runs.model` column from Task 3, `Run.model?: ModelSpec` from Task 4.
- Produces: `updateRunStatus(id, status, patch?: { finishedAt?, providerSessionRef?, model?: ModelSpec })` — the `model` field is new; consumed by `apps/worker/src/worker.ts` in Task 9.

- [ ] **Step 1: Write the failing test**

Add to `packages/db/src/__tests__/repositories/messages-runs-events.test.ts`, inside `describe("runs repository", ...)`:

```ts
  it("persists the model that actually executed the run", async () => {
    const session = await setupSession();
    const run = await createRun(session.id);
    const model = { family: "anthropic" as const, id: "claude-sonnet-5", maxTokens: 8192 };

    const updated = await updateRunStatus(run.id, "done", { finishedAt: new Date(), model });

    expect(updated?.model).toEqual(model);
    await expect(getRun(run.id)).resolves.toMatchObject({ model });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:db`
Expected: FAIL — `updateRunStatus`'s patch type has no `model` field (TypeScript error), and `toRun()` doesn't read `row.model`.

- [ ] **Step 3: Implement**

In `packages/db/src/repositories/runs.ts`, update the import line to include `ModelSpec`:

```ts
import type { ModelSpec, Run, RunStatus } from "@agentfactory/core";
```

In `toRun()`, add after `workspaceSnapshot: (row.workspaceSnapshot as Record<string, string>) ?? undefined,`:

```ts
    model: row.model ?? undefined,
```

Update `updateRunStatus`:

```ts
export async function updateRunStatus(
  id: number,
  status: RunStatus,
  patch?: { finishedAt?: Date; providerSessionRef?: string; model?: ModelSpec },
): Promise<Run | undefined> {
  const values: Partial<typeof runs.$inferInsert> = { status };
  if (patch?.finishedAt !== undefined) values.finishedAt = patch.finishedAt;
  if (patch?.providerSessionRef !== undefined) values.providerSessionRef = patch.providerSessionRef;
  if (patch?.model !== undefined) values.model = patch.model;

  const [row] = await db.update(runs).set(values).where(eq(runs.id, id)).returning();
  return row ? toRun(row) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:db`
Expected: PASS, including all pre-existing `runs repository` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/runs.ts packages/db/src/__tests__/repositories/messages-runs-events.test.ts
git commit -m "Persist the model that actually executed a run"
```

---

## PR 3 — Worker escalation logic (`apps/worker`)

**Files touched:** `apps/worker/sandbox-image/run-turn.ts`, `apps/worker/src/agent-runtime.ts`, `apps/worker/src/__tests__/agent-runtime.test.ts`, `apps/worker/src/model-escalation.ts`, `apps/worker/src/__tests__/model-escalation.test.ts`, `apps/worker/src/worker.ts` (6 files)

### Task 6: Signal context overflow from the sandboxed `run-turn.ts`

**Files:**
- Modify: `apps/worker/sandbox-image/run-turn.ts`

**Interfaces:**
- Produces: a new stdout sentinel `__ERROR__{"code":"prompt_too_long"}\n`, written instead of throwing to the top-level `.catch` when (and only when) the SDK's error message contains `"Prompt is too long"`. Consumed by `apps/worker/src/agent-runtime.ts` in Task 7.

This file lives outside the `src/` tree the unit-test glob covers and has no typecheck script of its own (confirmed: `apps/worker/sandbox-image/package.json` has no `scripts` block). It isn't runnable in isolation — it only runs inside the Docker sandbox image against a live SDK call. Task 7's tests simulate its output by constructing the exact marker string this task defines; verification here is a careful reading of the diff against those exact literals plus the manual reproduction steps at the end of this task.

- [ ] **Step 1: Wrap the query loop and detect the overflow signature**

In `apps/worker/sandbox-image/run-turn.ts`, add a new marker constant after `EVENT_MARKER`:

```ts
// Prefixes a structured-error line the host worker (agent-runtime.ts) checks for before falling
// back to its generic "no result line" failure — currently only used for context overflow.
const ERROR_MARKER = "__ERROR__";
```

Wrap the existing `for await (const message of query({...})) { ... }` loop in try/catch:

```ts
  try {
    for await (const message of query({
      prompt: userText,
      options: {
        model,
        systemPrompt,
        cwd: "/workspace",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        resume,
        thinking: { type: "adaptive" },
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            const description = typeof input.description === "string" ? input.description : undefined;
            const command = typeof input.command === "string" ? input.command : undefined;
            const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
            const fallback = description ?? command ?? (filePath ? `${block.name}: ${filePath}` : block.name);
            process.stdout.write(
              `${EVENT_MARKER}${JSON.stringify({
                type: "thinking_delta",
                tool: block.name,
                description,
                command,
                filePath,
                text: `[${block.name}] ${fallback}\n`,
              })}\n`,
            );
          }
        }
      } else if (message.type === "result") {
        sessionId = message.session_id;
        if (message.subtype === "success") {
          resultText = message.result;
        } else {
          throw new Error(`Claude Agent SDK run failed: ${message.subtype} (${message.errors.join(", ") || "no details"})`);
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Prompt is too long")) {
      process.stdout.write(`${ERROR_MARKER}${JSON.stringify({ code: "prompt_too_long" })}\n`);
      return;
    }
    throw err;
  }
```

(Everything inside the `try` is the loop body exactly as it exists today — only the surrounding `try { ... } catch (err) { ... }` and the marker-detection logic are new.)

- [ ] **Step 2: Reproduce the original failure to confirm this fixes it end-to-end**

This is the same failure this whole feature was designed around (task T-166, session resumed with `claude-haiku-4-5`, "Prompt is too long"). If a local dev environment with the worker running is available: send another message in that session's chat UI and confirm the worker log (`console.error` added earlier in `apps/worker/src/worker.ts`) no longer shows a bare `Prompt is too long` crash — once Tasks 7-9 are also done, it should show a `model_escalated` event instead. This step is a checkpoint to run again after Task 9, not blocking on its own — record it as pending and revisit once PR 3 is complete.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/sandbox-image/run-turn.ts
git commit -m "Signal context overflow via a stdout sentinel instead of a bare crash"
```

### Task 7: `PromptTooLongError` in `agent-runtime.ts`

**Files:**
- Modify: `apps/worker/src/agent-runtime.ts`
- Test: `apps/worker/src/__tests__/agent-runtime.test.ts` (new)

**Interfaces:**
- Consumes: `__ERROR__{"code":"prompt_too_long"}` sentinel from Task 6.
- Produces: `export class PromptTooLongError extends Error` — consumed by `apps/worker/src/worker.ts` in Task 9.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/src/__tests__/agent-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";
import { PromptTooLongError, runAgentTurn } from "../agent-runtime";

function fakeSandbox(chunks: OutputChunk[]): SandboxProvider {
  return {
    create: vi.fn(),
    exec: async function* () {
      for (const chunk of chunks) yield chunk;
    },
    writeFiles: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    resetMemory: vi.fn(),
  };
}

function baseParams(sandboxProvider: SandboxProvider) {
  return {
    sandboxProvider,
    sandboxId: "sandbox-1",
    systemPrompt: "Be helpful.",
    model: { family: "anthropic" as const, id: "claude-haiku-4-5", maxTokens: 8192 },
    userText: "What model are you using?",
  };
}

describe("runAgentTurn", () => {
  it("returns the parsed result when the sandbox succeeds", async () => {
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    await expect(runAgentTurn(baseParams(sandbox))).resolves.toEqual({ text: "Hi", providerSessionRef: "ref-1" });
  });

  it("throws PromptTooLongError when the sandbox emits the overflow marker", async () => {
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "prompt_too_long" })}\n` },
    ]);

    await expect(runAgentTurn(baseParams(sandbox))).rejects.toBeInstanceOf(PromptTooLongError);
  });

  it("throws a generic error when the sandbox produces neither marker", async () => {
    const sandbox = fakeSandbox([{ stream: "stderr", data: "container crashed\n" }]);

    await expect(runAgentTurn(baseParams(sandbox))).rejects.toThrow(/produced no result line/);
  });
});
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `pnpm vitest run --project unit apps/worker/src/__tests__/agent-runtime.test.ts`
Expected: the first and third tests PASS (unchanged behavior); the `PromptTooLongError` test FAILS — `PromptTooLongError` isn't exported and the `__ERROR__` marker isn't checked.

- [ ] **Step 3: Implement**

In `apps/worker/src/agent-runtime.ts`, add after the `EVENT_MARKER` constant:

```ts
// Must match ERROR_MARKER in apps/worker/sandbox-image/run-turn.ts.
const ERROR_MARKER = "__ERROR__";

export class PromptTooLongError extends Error {
  constructor() {
    super("Prompt is too long for the assigned model's context window");
    this.name = "PromptTooLongError";
  }
}
```

Before the existing `markerIndex`/`RESULT_MARKER` check, add:

```ts
  const errorIndex = stdout.lastIndexOf(ERROR_MARKER);
  if (errorIndex !== -1) {
    const errorLine = stdout.slice(errorIndex + ERROR_MARKER.length).split("\n")[0];
    const errorPayload = JSON.parse(errorLine) as { code: string };
    if (errorPayload.code === "prompt_too_long") throw new PromptTooLongError();
  }

```

(This goes immediately before the existing `const markerIndex = stdout.lastIndexOf(RESULT_MARKER);` line — the rest of that function is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run --project unit apps/worker/src/__tests__/agent-runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/agent-runtime.ts apps/worker/src/__tests__/agent-runtime.test.ts
git commit -m "Classify context-overflow failures as PromptTooLongError"
```

### Task 8: `resolveEscalation` in `apps/worker/src/model-escalation.ts`

**Files:**
- Create: `apps/worker/src/model-escalation.ts`
- Test: `apps/worker/src/__tests__/model-escalation.test.ts` (new)

**Interfaces:**
- Consumes: `nextEscalationTier` from `@agentfactory/core` (Task 1), `OverflowPolicy` from `@agentfactory/core` (Task 4).
- Produces: `resolveEscalation(currentModelId: string, policy: OverflowPolicy): string | undefined` — consumed by `apps/worker/src/worker.ts` in Task 9.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/__tests__/model-escalation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveEscalation } from "../model-escalation";

describe("resolveEscalation", () => {
  it("walks the ladder under the fallback policy", () => {
    expect(resolveEscalation("claude-haiku-4-5", "fallback")).toBe("claude-sonnet-5");
    expect(resolveEscalation("claude-sonnet-5", "fallback")).toBe("claude-opus-5");
  });

  it("stops at the top of the ladder under the fallback policy", () => {
    expect(resolveEscalation("claude-opus-5", "fallback")).toBeUndefined();
  });

  it("never escalates a model outside the ladder, fallback or not", () => {
    expect(resolveEscalation("claude-fable-5", "fallback")).toBeUndefined();
  });

  it("never escalates under the fail_fast policy", () => {
    expect(resolveEscalation("claude-haiku-4-5", "fail_fast")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit apps/worker/src/__tests__/model-escalation.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/worker/src/model-escalation.ts`:

```ts
import type { OverflowPolicy } from "@agentfactory/core";
import { nextEscalationTier } from "@agentfactory/core";

// Given the model a turn just overflowed on and the agent's overflow policy, returns the model
// id to retry with, or undefined if escalation should stop — either the policy is fail_fast, or
// the ladder's exhausted (already on claude-opus-5, or on claude-fable-5 which isn't on it at all).
export function resolveEscalation(currentModelId: string, policy: OverflowPolicy): string | undefined {
  if (policy === "fail_fast") return undefined;
  return nextEscalationTier(currentModelId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --project unit apps/worker/src/__tests__/model-escalation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/model-escalation.ts apps/worker/src/__tests__/model-escalation.test.ts
git commit -m "Add pure escalation-decision helper for the worker's retry loop"
```

### Task 9: Wire the retry loop into `worker.ts`

**Files:**
- Modify: `apps/worker/src/worker.ts`

**Interfaces:**
- Consumes: `PromptTooLongError` (Task 7), `resolveEscalation` (Task 8), `buildModelSpec` (existing, `@agentfactory/core`), `agent.onContextOverflow` (Task 4), `updateRunStatus(..., { model })` (Task 5), `ModelEscalatedEvent`'s `"model_escalated"` shape (Task 2).

This is BullMQ job-processor wiring, not independently unit tested — consistent with the rest of `worker.ts` today (only `scm-provider.ts`, a pure module it calls into, has tests). The branching logic it delegates to (`resolveEscalation`) is fully covered by Task 8's tests. Verification here is typecheck plus the manual reproduction from Task 6, Step 2.

- [ ] **Step 1: Update imports**

In `apps/worker/src/worker.ts`, change:

```ts
import { type Session, formatSharedContextForPrompt } from "@agentfactory/core";
```

to:

```ts
import { type Session, buildModelSpec, formatSharedContextForPrompt } from "@agentfactory/core";
```

Change:

```ts
import { runAgentTurn } from "./agent-runtime";
```

to:

```ts
import { type AgentTurnResult, PromptTooLongError, runAgentTurn } from "./agent-runtime";
```

Add a new import:

```ts
import { resolveEscalation } from "./model-escalation";
```

- [ ] **Step 2: Replace the single `runAgentTurn` call with a retry loop**

Replace this block:

```ts
      let seq = 1;
      const { text, providerSessionRef } = await runAgentTurn({
        sandboxProvider,
        sandboxId,
        systemPrompt: teamContextPrefix + agent.systemPrompt,
        model: task?.model ?? agent.model,
        userText: (triggeringMessage?.content ?? "") + issueContext,
        resumeSessionRef,
        workspace,
        onEvent: async (type, data) => {
          await createEvent(runId, seq++, type, data);
        },
      });
```

with:

```ts
      let seq = 1;
      let attemptModel = task?.model ?? agent.model;
      let turnResult!: AgentTurnResult;
      for (;;) {
        try {
          turnResult = await runAgentTurn({
            sandboxProvider,
            sandboxId,
            systemPrompt: teamContextPrefix + agent.systemPrompt,
            model: attemptModel,
            userText: (triggeringMessage?.content ?? "") + issueContext,
            resumeSessionRef,
            workspace,
            onEvent: async (type, data) => {
              await createEvent(runId, seq++, type, data);
            },
          });
          break;
        } catch (err) {
          if (!(err instanceof PromptTooLongError)) throw err;
          const nextModelId = resolveEscalation(attemptModel.id, agent.onContextOverflow);
          if (!nextModelId) throw err;
          const nextModel = buildModelSpec(nextModelId);
          await createEvent(runId, seq++, "model_escalated", {
            fromModel: attemptModel.id,
            toModel: nextModel.id,
            reason: "context_overflow",
          });
          attemptModel = nextModel;
        }
      }
      const { text, providerSessionRef } = turnResult;
```

- [ ] **Step 3: Persist the model that actually ran**

Change:

```ts
      await updateRunStatus(runId, "done", { finishedAt: new Date(), providerSessionRef });
```

to:

```ts
      await updateRunStatus(runId, "done", { finishedAt: new Date(), providerSessionRef, model: attemptModel });
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: PASS.

- [ ] **Step 5: Manual end-to-end check (completes Task 6, Step 2)**

If a local dev environment with the worker running is available, reproduce the original failure: a session assigned `claude-haiku-4-5` with a large history, send a follow-up message. Confirm in the worker log:
- No bare `Prompt is too long` crash.
- The run's event stream contains a `model_escalated` event (`fromModel: "claude-haiku-4-5"`, `toModel: "claude-sonnet-5"`).
- The chat reply succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/worker.ts
git commit -m "Retry overflowed runs on the next escalation tier"
```

---

## PR 4 — Web UI for the agent policy field

**Files touched:** `apps/web/src/app/api/agents/route.ts`, `apps/web/src/app/api/agents/[agentId]/route.ts`, `apps/web/src/app/(app)/teams-v2/page.tsx`, `apps/web/src/lib/i18n/dictionaries/en.ts` (4 files)

### Task 10: Validate `onContextOverflow` in the agent API routes

**Files:**
- Modify: `apps/web/src/app/api/agents/route.ts`
- Modify: `apps/web/src/app/api/agents/[agentId]/route.ts`

**Interfaces:**
- Consumes: `isValidOverflowPolicy` from `@agentfactory/core` (Task 4).

No dedicated test file exists for these route handlers today (none of `apps/web/src/app/api/agents/**` has a `__tests__` sibling) — this task follows that existing pattern; verification is typecheck plus the manual check in Step 3.

- [ ] **Step 1: Update `apps/web/src/app/api/agents/route.ts`**

Change:

```ts
import { isValidModelId } from "@agentfactory/core";
```

to:

```ts
import { isValidModelId, isValidOverflowPolicy } from "@agentfactory/core";
```

In `POST`, after the existing model validation block:

```ts
  if (body.model !== undefined && !isValidModelId(body.model)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
```

add:

```ts
  if (body.onContextOverflow !== undefined && !isValidOverflowPolicy(body.onContextOverflow)) {
    return NextResponse.json({ error: "Invalid onContextOverflow value" }, { status: 400 });
  }
```

- [ ] **Step 2: Same change in `apps/web/src/app/api/agents/[agentId]/route.ts`**

Apply the identical import change and the identical validation block (after its existing `isValidModelId` check in `PATCH`) to `apps/web/src/app/api/agents/[agentId]/route.ts`.

- [ ] **Step 3: Typecheck and manual verification**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: PASS.

Manual check (curl against the running dev server, authenticated session cookie required):

```bash
curl -s -X PATCH http://localhost:3000/api/agents/1 \
  -H "Content-Type: application/json" \
  -H "Cookie: <session cookie>" \
  -d '{"onContextOverflow":"not-a-real-policy"}'
```

Expected: `400 {"error":"Invalid onContextOverflow value"}`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/agents/route.ts "apps/web/src/app/api/agents/[agentId]/route.ts"
git commit -m "Validate onContextOverflow on agent create/update routes"
```

### Task 11: Agent settings field in `teams-v2/page.tsx`

**Files:**
- Modify: `apps/web/src/app/(app)/teams-v2/page.tsx`
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts`

**Interfaces:**
- Consumes: `agent.onContextOverflow` (Task 4), `updateAgent`/`createAgent` from `useMockBackend()` (already threads arbitrary fields through to the real `/api/agents` routes via `apiFetch` — no change needed there, confirmed in `apps/web/src/lib/mock/context.tsx`).

This is a form field addition mirroring the existing `Model` select exactly. No test file — this page has no existing `__tests__` coverage to extend (matches the codebase's current state; `apps/web/src/components/__tests__/` exists for other components but not this page).

- [ ] **Step 1: Add i18n strings**

In `apps/web/src/lib/i18n/dictionaries/en.ts`, inside the `teamsV2` block, add after `modelLabel: "Model",`:

```ts
    onContextOverflowLabel: "On context overflow",
    onContextOverflowFallback: "Escalate to a larger model",
    onContextOverflowFailFast: "Fail (keep assigned model)",
```

- [ ] **Step 2: Add the field to `NewAgentPanel`**

In `apps/web/src/app/(app)/teams-v2/page.tsx`, in `NewAgentPanel`, add new state after `const [model, setModel] = useState(DEFAULT_MODEL_ID);`:

```ts
  const [onContextOverflow, setOnContextOverflow] = useState<"fallback" | "fail_fast">("fallback");
```

Include it in the create call:

```ts
      const agent = await createAgent({ name: name.trim(), description: description.trim(), systemPrompt: systemPrompt.trim(), mode, teamId, model, onContextOverflow });
```

Add the select, immediately after the existing Model `<select>` block (after its closing `</div>`, still inside the `space-y-4` container):

```tsx
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.onContextOverflowLabel")}
          </label>
          <select
            value={onContextOverflow}
            onChange={(e) => setOnContextOverflow(e.target.value as "fallback" | "fail_fast")}
            className={selectClassName}
          >
            <option value="fallback">{t("teamsV2.onContextOverflowFallback")}</option>
            <option value="fail_fast">{t("teamsV2.onContextOverflowFailFast")}</option>
          </select>
        </div>
```

- [ ] **Step 3: Add the field to `AgentDetailPanel`**

In `AgentDetailPanel`, add state after `const [model, setModel] = useState(agent.model.id);`:

```ts
  const [onContextOverflow, setOnContextOverflow] = useState(agent.onContextOverflow);
```

Include it in the `dirty` check:

```ts
  const dirty =
    systemPrompt !== agent.systemPrompt ||
    defaultCodebase !== (agent.defaultCodebase ?? "") ||
    model !== agent.model.id ||
    onContextOverflow !== agent.onContextOverflow ||
    sortedJson(areaMap) !== sortedJson(agent.areaMap ?? {});
```

Include it in the save call:

```ts
      await updateAgent(agent.id, { systemPrompt, defaultCodebase, areaMap, model, onContextOverflow });
```

Add the same select block as Step 2, immediately after the existing Model `<select>` block in this panel.

- [ ] **Step 4: Verify in the browser**

Run: `pnpm --filter @agentfactory/web dev` (or use the existing preview if already running).
Navigate to `/teams-v2`, open a team, create or edit an agent. Confirm the "On context overflow" select appears below "Model" with both options, and that saving persists the choice (reload the page and confirm the select shows the saved value).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(app)/teams-v2/page.tsx" apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "Add on-context-overflow policy field to agent settings"
```
