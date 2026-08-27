# Run Context Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-26-run-context-eval-design.md` — read it before starting.

**Goal:** On any finished run, a user can click **Evaluate** and get back a scored, evidenced report of which human-authored prompt instructions the run followed.

**Architecture:** A `run_evals` table (own table, never on `Run`), a fourth BullMQ queue, and a worker handler that resolves the run's artefact (branch diff or final message — never a silent fallback), makes one structured-output judge call, and stores a `RunEvalResult`. Two API routes create/list evals; a fourth task-page tab renders them.

**Tech Stack:** TypeScript, drizzle-orm + Postgres, BullMQ + IORedis, `@anthropic-ai/sdk` (forced `tool_choice` for structured output), Next.js 16 App Router, vitest (+ jsdom for components), Playwright.

## Global Constraints

- Judge model is the worker's default — `DEFAULT_MODEL_ID` from `@agentfactory/core` (`"claude-sonnet-5"`) — stamped on every card as `judge_model_id`. Not configurable.
- Only human-authored layers are judged: segment ids `team_context` and `agent_system_prompt`, non-empty text.
- The artefact rule never falls back on error: run committed → branch diff; never committed → final assistant message; intended artefact unfetchable → the eval **fails** with `artefact_unavailable`.
- Failure reason codes (stored in `run_evals.error`, i18n-mapped in the UI): `run_never_composed_prompt`, `no_human_context`, `artefact_unavailable`, `insufficient_credit`, `judge_error`.
- `score` = passed / total checkable requirements, in 0..1; **0 when zero requirements** — zero checkable is a valid result, not an error.
- All user-facing strings go through `t()` — add keys to `apps/web/src/lib/i18n/dictionaries/en.ts` under `taskDetail` first (the `TranslationKey` type updates automatically).
- Domain types live in `packages/core/src/domain.ts` only — never duplicated, never provider types in DB/API layers.
- No retention/pruning, no auto-eval, no A/B comparison, no configurable judge (all explicitly out of scope).
- Run every command from the worktree root: `/Users/erankaufman/Development/AgentFactory/.claude/worktrees/what-does-it-mean-b238cb`.
- `pnpm test:db` and `pnpm test:queue` need the local scratch Postgres/Redis, same as the existing suites; nothing new to set up.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/domain.ts` (modify) | `EvalStatus`, `EvalVerdict`, `EvalArtefactKind`, `EvalRequirement`, `EvalLayerResult`, `RunEvalResult`, `RunEval` |
| `packages/db/src/schema.ts` (modify) | `eval_status` enum + `run_evals` table |
| `packages/db/drizzle/0015_*.sql` (generated) | migration |
| `packages/db/src/repositories/run-evals.ts` (create) | eval row lifecycle, org-scoped list |
| `packages/db/src/repositories/messages.ts` (modify) | `getFinalAssistantMessageForRun` |
| `packages/queue/src/index.ts` (modify) | `EVAL_QUEUE_NAME`, `EvalJobData`, `enqueueEvalJob` |
| `apps/worker/src/scm-provider.ts` (modify) | `fetchBranchDiff` (GitHub compare API, raw diff) |
| `apps/worker/src/eval-artefact.ts` (create) | artefact rule: diff vs final message vs `ArtefactUnavailableError` |
| `apps/worker/src/eval-judge.ts` (create) | segment selection, judge prompt, forced-tool call, output validation, score |
| `apps/worker/src/eval-runner.ts` (create) | the 5-step handler orchestration (dependency-injected for tests) |
| `apps/worker/src/worker.ts` (modify) | fourth `Worker` wiring |
| `apps/web/src/app/api/runs/[runId]/evals/route.ts` (create) | POST create+enqueue, GET list |
| `apps/web/src/lib/i18n/dictionaries/en.ts` (modify) | all eval copy |
| `apps/web/src/components/RunEvalPanel.tsx` (create) | the Evaluation tab body, modeled on `RunContextPanel` |
| `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` (modify) | fourth tab wiring |
| `apps/web/e2e/run-eval.spec.ts` (create) | routes + tab end to end |

---

### Task 1: Core domain types

**Files:**
- Modify: `packages/core/src/domain.ts` (append after the `RunPrompt` interface, ~line 269)

**Interfaces:**
- Consumes: existing `ID` type alias in `domain.ts`.
- Produces (everything below is imported by Tasks 2–10 from `@agentfactory/core` — the barrel re-exports domain automatically): `EvalStatus`, `EvalVerdict`, `EvalArtefactKind`, `EvalRequirement`, `EvalLayerResult`, `RunEvalResult`, `RunEval`.

House convention: nullable DB columns surface as optional (`?:`) domain fields, never `| null` (see `Run`); dates are ISO strings.

- [ ] **Step 1: Add the types**

```ts
// ── Run evals ────────────────────────────────────────────────────────────────
// One row per judge invocation — a run can be evaluated more than once, so this
// is its own entity, never a column on Run (the task page polls Run on a timer;
// see the workspaceSnapshot over-fetch lesson).

export type EvalStatus = "queued" | "running" | "done" | "failed";
export type EvalVerdict = "pass" | "fail" | "unclear";
// What the judge graded: the branch's diff when the run committed, otherwise the
// run's final assistant message. Stored so no score is ambiguous about its input.
export type EvalArtefactKind = "diff" | "final_message";

export interface EvalRequirement {
  text: string;
  verdict: EvalVerdict;
  // A quoted line from the artefact (or a brief statement of what is absent).
  evidence: string;
}

export interface EvalLayerResult {
  // PromptSegment id — "team_context" | "agent_system_prompt" in practice.
  segmentId: string;
  requirements: EvalRequirement[];
}

export interface RunEvalResult {
  artefactKind: EvalArtefactKind;
  layers: EvalLayerResult[];
  // passed / total checkable requirements, 0..1; 0 when none were checkable.
  score: number;
}

export interface RunEval {
  id: ID;
  orgId: ID;
  runId: ID;
  status: EvalStatus;
  result?: RunEvalResult;
  // Which model graded — scores from different judges are not comparable.
  judgeModelId?: string;
  // Machine-readable failure reason code; only set when status is "failed".
  error?: string;
  createdAt: string;
  completedAt?: string;
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck`
Expected: PASS (types are additive).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/domain.ts
git commit -m "feat(core): add run-eval domain types"
```

---

### Task 2: `run_evals` schema, migration, and repository

**Files:**
- Modify: `packages/db/src/schema.ts` (enum next to `runStatusEnum` ~line 194; table after `runs`)
- Modify: `packages/db/src/index.ts` (add the repository export)
- Create: `packages/db/src/repositories/run-evals.ts`
- Create (generated): `packages/db/drizzle/0015_*.sql`
- Test: `packages/db/src/__tests__/repositories/run-evals.test.ts`

**Interfaces:**
- Consumes: `RunEval`, `RunEvalResult` from Task 1; existing `orgs`, `runs` tables; test fixtures `insertOrg`, `insertAgent`, `insertSession` and `createRun`.
- Produces (used by Tasks 6–8): `createRunEval(orgId: number, runId: number): Promise<RunEval>`, `getRunEval(id: number): Promise<RunEval | undefined>`, `markEvalRunning(id: number): Promise<void>`, `completeEval(id: number, result: RunEvalResult, judgeModelId: string): Promise<RunEval>`, `failEval(id: number, error: string): Promise<RunEval>`, `listEvalsForRun(runId: number, orgId: number): Promise<RunEval[]>`.

- [ ] **Step 1: Write the failing test**

`packages/db/src/__tests__/repositories/run-evals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import "../setup.js";
import type { RunEvalResult } from "@agentfactory/core";
import { createRun } from "../../repositories/runs.js";
import {
  completeEval,
  createRunEval,
  failEval,
  getRunEval,
  listEvalsForRun,
  markEvalRunning,
} from "../../repositories/run-evals.js";
import { insertAgent, insertOrg, insertSession } from "../fixtures.js";

async function setupRun() {
  const org = await insertOrg();
  const agent = await insertAgent(org.id);
  const session = await insertSession(org.id, agent.id);
  const run = await createRun(session.id);
  return { org, run };
}

const RESULT: RunEvalResult = {
  artefactKind: "diff",
  score: 0.5,
  layers: [
    {
      segmentId: "team_context",
      requirements: [
        { text: "Use conventional commit messages", verdict: "pass", evidence: "feat(core): add parser" },
        { text: "Update the changelog", verdict: "fail", evidence: "No CHANGELOG edit anywhere in the diff" },
      ],
    },
  ],
};

describe("run-evals repository", () => {
  it("creates a queued eval and reads it back", async () => {
    const { org, run } = await setupRun();
    const runEval = await createRunEval(org.id, run.id);

    expect(runEval).toMatchObject({ orgId: org.id, runId: run.id, status: "queued" });
    expect(runEval.result).toBeUndefined();
    expect(runEval.completedAt).toBeUndefined();
    await expect(getRunEval(runEval.id)).resolves.toEqual(runEval);
  });

  it("walks queued → running → done, storing the result and judge model", async () => {
    const { org, run } = await setupRun();
    const runEval = await createRunEval(org.id, run.id);

    await markEvalRunning(runEval.id);
    await expect(getRunEval(runEval.id)).resolves.toMatchObject({ status: "running" });

    const done = await completeEval(runEval.id, RESULT, "claude-sonnet-5");
    expect(done).toMatchObject({ status: "done", result: RESULT, judgeModelId: "claude-sonnet-5" });
    expect(done.completedAt).toBeDefined();
    expect(done.error).toBeUndefined();
  });

  it("fails an eval with a machine-readable reason", async () => {
    const { org, run } = await setupRun();
    const runEval = await createRunEval(org.id, run.id);

    const failed = await failEval(runEval.id, "artefact_unavailable");
    expect(failed).toMatchObject({ status: "failed", error: "artefact_unavailable" });
    expect(failed.result).toBeUndefined();
    expect(failed.completedAt).toBeDefined();
  });

  it("lists evals for a run newest first, scoped to the org", async () => {
    const { org, run } = await setupRun();
    const first = await createRunEval(org.id, run.id);
    const second = await createRunEval(org.id, run.id);

    const listed = await listEvalsForRun(run.id, org.id);
    expect(listed.map((e) => e.id)).toEqual([second.id, first.id]);

    const otherOrg = await insertOrg({ slug: `other-${Date.now()}` });
    await expect(listEvalsForRun(run.id, otherOrg.id)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:db -- run-evals`
Expected: FAIL — cannot resolve `../../repositories/run-evals.js`.

- [ ] **Step 3: Add the schema**

In `packages/db/src/schema.ts`, add `RunEvalResult` to the existing type import from `@agentfactory/core`, then below the `runs` table:

```ts
export const evalStatusEnum = pgEnum("eval_status", ["queued", "running", "done", "failed"]);

// One row per judge invocation against a run — deliberately its own table, never columns on
// runs: a run can be evaluated repeatedly, and the task page polls runs on a ~1.5s timer
// (the workspaceSnapshot over-fetch lesson). org_id is denormalized so list queries are
// org-scoped without the runs → sessions → agents join.
export const runEvals = pgTable("run_evals", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  runId: integer("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  status: evalStatusEnum("status").notNull().default("queued"),
  // RunEvalResult from @agentfactory/core; null until the eval reaches "done".
  result: jsonb("result").$type<RunEvalResult>(),
  // Which model graded — scores from different judges are not comparable, so every card says.
  judgeModelId: text("judge_model_id"),
  // Machine-readable failure reason (e.g. "artefact_unavailable"); null unless failed.
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @agentfactory/db db:generate`
Expected: a new `packages/db/drizzle/0015_*.sql` creating the `eval_status` enum and `run_evals` table. Inspect it; do not hand-edit. (The db-test setup migrates the scratch database automatically; apply to your dev database later with `pnpm --filter @agentfactory/db db:migrate`.)

- [ ] **Step 5: Write the repository**

`packages/db/src/repositories/run-evals.ts`:

```ts
import { and, desc, eq } from "drizzle-orm";
import type { RunEval, RunEvalResult } from "@agentfactory/core";
import { db } from "../client";
import { runEvals } from "../schema";

function toRunEval(row: typeof runEvals.$inferSelect): RunEval {
  return {
    id: row.id,
    orgId: row.orgId,
    runId: row.runId,
    status: row.status,
    result: row.result ?? undefined,
    judgeModelId: row.judgeModelId ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
  };
}

export async function createRunEval(orgId: number, runId: number): Promise<RunEval> {
  const [row] = await db.insert(runEvals).values({ orgId, runId }).returning();
  return toRunEval(row);
}

export async function getRunEval(id: number): Promise<RunEval | undefined> {
  const [row] = await db.select().from(runEvals).where(eq(runEvals.id, id));
  return row ? toRunEval(row) : undefined;
}

export async function markEvalRunning(id: number): Promise<void> {
  await db.update(runEvals).set({ status: "running" }).where(eq(runEvals.id, id));
}

export async function completeEval(
  id: number,
  result: RunEvalResult,
  judgeModelId: string,
): Promise<RunEval> {
  const [row] = await db
    .update(runEvals)
    .set({ status: "done", result, judgeModelId, completedAt: new Date() })
    .where(eq(runEvals.id, id))
    .returning();
  return toRunEval(row);
}

export async function failEval(id: number, error: string): Promise<RunEval> {
  const [row] = await db
    .update(runEvals)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(eq(runEvals.id, id))
    .returning();
  return toRunEval(row);
}

// Newest first (id as tiebreak — same-millisecond inserts are routine in tests). Org-scoped
// via the denormalized org_id so a caller can never list another tenant's evals.
export async function listEvalsForRun(runId: number, orgId: number): Promise<RunEval[]> {
  const rows = await db
    .select()
    .from(runEvals)
    .where(and(eq(runEvals.runId, runId), eq(runEvals.orgId, orgId)))
    .orderBy(desc(runEvals.createdAt), desc(runEvals.id));
  return rows.map(toRunEval);
}
```

Add to `packages/db/src/index.ts` (after the `runs` repository export):

```ts
export * from "./repositories/run-evals";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test:db -- run-evals`
Expected: PASS (4 tests). Also run `pnpm typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/index.ts packages/db/src/repositories/run-evals.ts packages/db/src/__tests__/repositories/run-evals.test.ts packages/db/drizzle
git commit -m "feat(db): add run_evals table, migration, and repository"
```

---

### Task 3: Final-assistant-message query

**Files:**
- Modify: `packages/db/src/repositories/messages.ts`
- Test: `packages/db/src/__tests__/repositories/messages-runs-events.test.ts` (append to the existing `messages repository` describe)

**Interfaces:**
- Consumes: existing `messages` table (has `runId`, `role`), `toChatMessage` mapper, `createMessage(sessionId, role, content, runId?)`.
- Produces (used by Task 6): `getFinalAssistantMessageForRun(runId: number): Promise<ChatMessage | undefined>`.

- [ ] **Step 1: Write the failing tests** (append inside `describe("messages repository", ...)`; add `getFinalAssistantMessageForRun` to the existing messages import)

```ts
it("returns the final assistant message for a run", async () => {
  const session = await setupSession();
  const userMessage = await createMessage(session.id, "user", "Do the thing");
  const run = await createRun(session.id, userMessage.id);
  await createMessage(session.id, "assistant", "First draft", run.id);
  const final = await createMessage(session.id, "assistant", "Final answer", run.id);
  await createMessage(session.id, "user", "Unrelated follow-up");

  await expect(getFinalAssistantMessageForRun(run.id)).resolves.toEqual(final);
});

it("returns undefined when the run produced no assistant message", async () => {
  const session = await setupSession();
  const run = await createRun(session.id);
  await expect(getFinalAssistantMessageForRun(run.id)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:db -- messages-runs-events`
Expected: FAIL — `getFinalAssistantMessageForRun` is not exported.

- [ ] **Step 3: Implement** (in `messages.ts`; extend the drizzle import to `{ and, desc, eq }`)

```ts
// The eval artefact for a run that committed nothing: the final assistant message the run
// produced. Newest-by-id because a run appends exactly one assistant message today, but
// nothing enforces that — if a future runtime emits several, the last word is the deliverable.
export async function getFinalAssistantMessageForRun(runId: number): Promise<ChatMessage | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.runId, runId), eq(messages.role, "assistant")))
    .orderBy(desc(messages.id))
    .limit(1);
  return row ? toChatMessage(row) : undefined;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:db -- messages-runs-events`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories/messages.ts packages/db/src/__tests__/repositories/messages-runs-events.test.ts
git commit -m "feat(db): query a run's final assistant message"
```

---

### Task 4: Eval queue

**Files:**
- Modify: `packages/queue/src/index.ts`
- Test: `packages/queue/src/__tests__/eval-queue.test.ts`

**Interfaces:**
- Consumes: existing `queueConnection`, `Queue` pattern in the same file.
- Produces (used by Tasks 8–9): `EVAL_QUEUE_NAME = "evals"`, `interface EvalJobData { evalId: number }`, `enqueueEvalJob(evalId: number): Promise<void>` (job name `"process-eval"`). The name is pluralized to match `RUN_QUEUE_NAME = "runs"`; the spec's "fourth queue `eval`" refers to the same queue.

- [ ] **Step 1: Write the failing test**

`packages/queue/src/__tests__/eval-queue.test.ts` (exact mirror of `queue.test.ts`):

```ts
import "./setup.js";
import { Queue } from "bullmq";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EVAL_QUEUE_NAME, enqueueEvalJob, queueConnection } from "../index.js";

const inspectQueue = new Queue(EVAL_QUEUE_NAME, { connection: queueConnection });

afterEach(async () => {
  await inspectQueue.obliterate({ force: true });
});

afterAll(async () => {
  await inspectQueue.close();
  await queueConnection.quit();
});

describe("enqueueEvalJob", () => {
  it("adds a job carrying the eval id to the queue", async () => {
    await enqueueEvalJob(7);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("process-eval");
    expect(jobs[0].data).toEqual({ evalId: 7 });
  });

  it("enqueues multiple jobs independently", async () => {
    await enqueueEvalJob(1);
    await enqueueEvalJob(2);

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs.map((job) => job.data.evalId).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:queue -- eval-queue`
Expected: FAIL — `EVAL_QUEUE_NAME` / `enqueueEvalJob` not exported.

- [ ] **Step 3: Implement** (in `packages/queue/src/index.ts`, following the run queue's exact shape)

Next to the existing queue-name consts:

```ts
export const EVAL_QUEUE_NAME = "evals";
```

Next to the existing job-data interfaces:

```ts
export interface EvalJobData {
  evalId: number;
}
```

Next to the existing `Queue` instances:

```ts
const evalQueue = new Queue<EvalJobData>(EVAL_QUEUE_NAME, { connection: queueConnection });
```

Next to the existing enqueue helpers:

```ts
// Own queue rather than the run queue: an eval job would otherwise wait behind ~60s agent
// runs, and grading should start when the user clicks Evaluate.
export async function enqueueEvalJob(evalId: number): Promise<void> {
  await evalQueue.add("process-eval", { evalId });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:queue`
Expected: PASS, all queue suites.

- [ ] **Step 5: Commit**

```bash
git add packages/queue/src/index.ts packages/queue/src/__tests__/eval-queue.test.ts
git commit -m "feat(queue): add the evals queue"
```

---

### Task 5: Artefact resolution (branch diff fetch + the artefact rule)

**Files:**
- Modify: `apps/worker/src/scm-provider.ts` (new exported function)
- Create: `apps/worker/src/eval-artefact.ts`
- Test: `apps/worker/src/__tests__/eval-artefact.test.ts` (unit project)

**Interfaces:**
- Consumes: `CloneTarget { cloneUrl; branch; repoFullName; installationId }`, module-private `getInstallationToken`, `GITHUB_API`, and `resolveCloneTarget(orgId, codebase, branch)` from `scm-provider.ts`; `getFinalAssistantMessageForRun` from Task 3; `Session`, `Task`, `EvalArtefactKind` from core.
- Produces (used by Task 6's runner):
  - `fetchBranchDiff(target: CloneTarget): Promise<string | undefined>` — `undefined` means the branch does not exist (the "never committed" signal); non-404 failures throw.
  - `interface EvalArtefact { kind: EvalArtefactKind; text: string }`
  - `class ArtefactUnavailableError extends Error`
  - `resolveEvalArtefact(runId: number, session: Session, task: Task | undefined, orgId: number, deps?: ArtefactDeps): Promise<EvalArtefact>` — throws `ArtefactUnavailableError`, never falls back on a fetch error.
  - `interface ArtefactDeps { resolveTarget; fetchDiff; getFinalMessage }` (the test seam; production uses the defaults).

The decision recorded in brainstorming: **branch missing (404) or empty compare = the run never committed → grade the final message; any other fetch failure = unfetchable → fail.** The 404 is an input to the artefact rule, not an error.

- [ ] **Step 1: Write the failing tests**

`apps/worker/src/__tests__/eval-artefact.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Session, Task } from "@agentfactory/core";
import { ArtefactUnavailableError, resolveEvalArtefact } from "../eval-artefact";
import type { CloneTarget } from "../scm-provider";

const SESSION = { id: 12, orgId: 1, agentId: 3 } as Session;
const TASK_WITH_REPO = { id: 5, codebase: "acme/backend" } as Task;
const TARGET: CloneTarget = {
  cloneUrl: "https://x-access-token:t@github.com/acme/backend.git",
  branch: "agent/session-12",
  repoFullName: "acme/backend",
  installationId: 99,
};

function makeDeps(overrides: Partial<Parameters<typeof resolveEvalArtefact>[4]> = {}) {
  return {
    resolveTarget: vi.fn().mockResolvedValue(TARGET),
    fetchDiff: vi.fn().mockResolvedValue("diff --git a/f b/f\n+line"),
    getFinalMessage: vi.fn().mockResolvedValue({ content: "Final answer" }),
    ...overrides,
  };
}

describe("resolveEvalArtefact", () => {
  it("grades the branch diff when the task has a codebase and the branch has changes", async () => {
    const deps = makeDeps();
    const artefact = await resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps);

    expect(artefact).toEqual({ kind: "diff", text: "diff --git a/f b/f\n+line" });
    expect(deps.resolveTarget).toHaveBeenCalledWith(1, "acme/backend", "agent/session-12");
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("grades the final message when the branch does not exist (run never committed)", async () => {
    const deps = makeDeps({ fetchDiff: vi.fn().mockResolvedValue(undefined) });
    const artefact = await resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps);
    expect(artefact).toEqual({ kind: "final_message", text: "Final answer" });
  });

  it("grades the final message when the compare is empty (branch exists, nothing committed)", async () => {
    const deps = makeDeps({ fetchDiff: vi.fn().mockResolvedValue("") });
    const artefact = await resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps);
    expect(artefact.kind).toBe("final_message");
  });

  it("fails — never falls back — when the diff fetch errors", async () => {
    const deps = makeDeps({ fetchDiff: vi.fn().mockRejectedValue(new Error("GitHub API compare failed: 500")) });
    await expect(resolveEvalArtefact(7, SESSION, TASK_WITH_REPO, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
    expect(deps.getFinalMessage).not.toHaveBeenCalled();
  });

  it("grades the final message directly when the task has no codebase", async () => {
    const deps = makeDeps();
    const artefact = await resolveEvalArtefact(7, SESSION, { id: 5 } as Task, 1, deps);
    expect(artefact.kind).toBe("final_message");
    expect(deps.resolveTarget).not.toHaveBeenCalled();
  });

  it("fails when there is no final message to grade", async () => {
    const deps = makeDeps({ getFinalMessage: vi.fn().mockResolvedValue(undefined) });
    await expect(resolveEvalArtefact(7, SESSION, undefined, 1, deps)).rejects.toBeInstanceOf(
      ArtefactUnavailableError,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit -- eval-artefact`
Expected: FAIL — cannot resolve `../eval-artefact`.

- [ ] **Step 3: Add `fetchBranchDiff` to `scm-provider.ts`** (near `resolveDefaultBranchSha`, whose repo-lookup shape it mirrors)

```ts
// The eval judge's artefact when a run committed: the branch's diff against the repo's default
// branch, straight from the GitHub compare API in raw diff form. Returns undefined when the
// branch does not exist — that is the artefact rule's "run never committed" signal, not an
// error. Every other non-OK answer throws: the caller must fail the eval rather than silently
// grade the wrong document.
export async function fetchBranchDiff(target: CloneTarget): Promise<string | undefined> {
  const token = await getInstallationToken(target.installationId);

  const repoRes = await fetch(`${GITHUB_API}/repos/${target.repoFullName}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!repoRes.ok) {
    throw new Error(`GitHub API repo lookup failed: ${repoRes.status} ${await repoRes.text().catch(() => "")}`);
  }
  const { default_branch: base } = (await repoRes.json()) as { default_branch: string };

  const compareRes = await fetch(
    `${GITHUB_API}/repos/${target.repoFullName}/compare/${base}...${encodeURIComponent(target.branch)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3.diff" } },
  );
  if (compareRes.status === 404) return undefined;
  if (!compareRes.ok) {
    throw new Error(`GitHub API compare failed: ${compareRes.status} ${await compareRes.text().catch(() => "")}`);
  }
  return compareRes.text();
}
```

(No unit test for this function itself — it is a thin network call, same stance as the rest of `scm-provider.ts`; the artefact rule around it is what the tests pin down.)

- [ ] **Step 4: Write `eval-artefact.ts`**

```ts
import type { EvalArtefactKind, Session, Task } from "@agentfactory/core";
import { getFinalAssistantMessageForRun } from "@agentfactory/db";
import { type CloneTarget, fetchBranchDiff, resolveCloneTarget } from "./scm-provider";

export interface EvalArtefact {
  kind: EvalArtefactKind;
  text: string;
}

// Raised when the artefact the rule selected cannot be produced. The eval must then fail —
// a score that quietly graded the wrong document is the worst output this feature can emit.
export class ArtefactUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtefactUnavailableError";
  }
}

// Dependency seam for unit tests; production callers rely on the defaults.
export interface ArtefactDeps {
  resolveTarget: (orgId: number, codebase: string, branch: string) => Promise<CloneTarget>;
  fetchDiff: (target: CloneTarget) => Promise<string | undefined>;
  getFinalMessage: (runId: number) => Promise<{ content: string } | undefined>;
}

const defaultDeps: ArtefactDeps = {
  resolveTarget: resolveCloneTarget,
  fetchDiff: fetchBranchDiff,
  getFinalMessage: getFinalAssistantMessageForRun,
};

// The artefact rule (spec §Design decisions): run committed → the branch diff; never
// committed → the run's final assistant message; intended artefact unfetchable → throw,
// never fall back. A missing branch (fetchDiff → undefined) or an empty compare means the
// run never committed — that routes to the final message BY THE RULE, not as a fallback.
export async function resolveEvalArtefact(
  runId: number,
  session: Session,
  task: Task | undefined,
  orgId: number,
  deps: ArtefactDeps = defaultDeps,
): Promise<EvalArtefact> {
  if (task?.codebase) {
    let diff: string | undefined;
    try {
      const target = await deps.resolveTarget(orgId, task.codebase, `agent/session-${session.id}`);
      diff = await deps.fetchDiff(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ArtefactUnavailableError(`branch diff fetch failed: ${message}`);
    }
    if (diff !== undefined && diff.trim() !== "") return { kind: "diff", text: diff };
  }

  const message = await deps.getFinalMessage(runId);
  if (!message || message.content.trim() === "") {
    throw new ArtefactUnavailableError(`run ${runId} has no final assistant message to grade`);
  }
  return { kind: "final_message", text: message.content };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test:unit -- eval-artefact`
Expected: PASS (6 tests). Also `pnpm typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/scm-provider.ts apps/worker/src/eval-artefact.ts apps/worker/src/__tests__/eval-artefact.test.ts
git commit -m "feat(worker): resolve the eval artefact — branch diff or final message, never a fallback"
```

---

### Task 6: The judge

**Files:**
- Create: `apps/worker/src/eval-judge.ts`
- Test: `apps/worker/src/__tests__/eval-judge.test.ts` (unit project)

**Interfaces:**
- Consumes: `DEFAULT_MODEL_ID`, `PromptSegment`, `EvalLayerResult`, `EvalVerdict`, `EvalArtefactKind`, `RunEvalResult` from core; `EvalArtefact` from Task 5; `@anthropic-ai/sdk` (already a worker dependency — mirror `claude-runtime.ts`'s client construction).
- Produces (used by Task 7):
  - `selectHumanSegments(segments: PromptSegment[]): PromptSegment[]`
  - `judgeCompliance(segments: PromptSegment[], artefact: EvalArtefact): Promise<{ result: RunEvalResult; judgeModelId: string }>`
  - Exported for tests: `buildJudgeUserMessage`, `validateJudgeLayers`, `computeResult`, `MAX_ARTEFACT_CHARS`.

- [ ] **Step 1: Write the failing tests**

`apps/worker/src/__tests__/eval-judge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EvalLayerResult, PromptSegment } from "@agentfactory/core";
import {
  MAX_ARTEFACT_CHARS,
  buildJudgeUserMessage,
  computeResult,
  selectHumanSegments,
  validateJudgeLayers,
} from "../eval-judge";

const SEGMENTS: PromptSegment[] = [
  { id: "platform_preamble", text: "You are an agent." },
  { id: "team_context", text: "Always update the changelog." },
  { id: "agent_system_prompt", text: "You are a reviewer." },
  { id: "repo_map", text: "src/..." },
];

describe("selectHumanSegments", () => {
  it("keeps only the human-authored layers", () => {
    expect(selectHumanSegments(SEGMENTS).map((s) => s.id)).toEqual(["team_context", "agent_system_prompt"]);
  });

  it("drops human layers whose text is empty (omitted at composition time)", () => {
    const segments: PromptSegment[] = [
      { id: "team_context", text: "", omittedReason: "no_team" },
      { id: "agent_system_prompt", text: "  " },
    ];
    expect(selectHumanSegments(segments)).toEqual([]);
  });
});

describe("buildJudgeUserMessage", () => {
  it("wraps each layer and the artefact in labeled blocks", () => {
    const message = buildJudgeUserMessage(selectHumanSegments(SEGMENTS), { kind: "diff", text: "+added line" });
    expect(message).toContain('<layer id="team_context">');
    expect(message).toContain('<layer id="agent_system_prompt">');
    expect(message).toContain("<artefact>");
    expect(message).toContain("+added line");
    expect(message).toContain("diff");
  });

  it("truncates an oversized artefact and says so", () => {
    const message = buildJudgeUserMessage([], { kind: "diff", text: "x".repeat(MAX_ARTEFACT_CHARS + 100) });
    expect(message).toContain("[artefact truncated]");
    expect(message.length).toBeLessThan(MAX_ARTEFACT_CHARS + 1_000);
  });
});

describe("validateJudgeLayers", () => {
  const VALID = {
    layers: [
      {
        segmentId: "team_context",
        requirements: [{ text: "Update the changelog", verdict: "fail", evidence: "No CHANGELOG edit" }],
      },
    ],
  };

  it("accepts a well-formed report", () => {
    expect(validateJudgeLayers(VALID)).toEqual(VALID.layers);
  });

  it("rejects a segmentId outside the human layers", () => {
    const bad = { layers: [{ segmentId: "repo_map", requirements: [] }] };
    expect(() => validateJudgeLayers(bad)).toThrow(/segmentId/);
  });

  it("rejects an unknown verdict", () => {
    const bad = {
      layers: [{ segmentId: "team_context", requirements: [{ text: "t", verdict: "maybe", evidence: "e" }] }],
    };
    expect(() => validateJudgeLayers(bad)).toThrow(/malformed/);
  });

  it("rejects a missing layers array", () => {
    expect(() => validateJudgeLayers({})).toThrow(/layers/);
  });
});

describe("computeResult", () => {
  it("scores passed over total checkable requirements", () => {
    const layers: EvalLayerResult[] = [
      {
        segmentId: "team_context",
        requirements: [
          { text: "a", verdict: "pass", evidence: "" },
          { text: "b", verdict: "pass", evidence: "" },
          { text: "c", verdict: "fail", evidence: "" },
          { text: "d", verdict: "unclear", evidence: "" },
        ],
      },
    ];
    const result = computeResult(layers, "diff");
    expect(result.score).toBe(0.5);
    expect(result.artefactKind).toBe("diff");
    expect(result.layers).toBe(layers);
  });

  it("scores 0 when there are no checkable requirements — a valid result, not an error", () => {
    const result = computeResult([{ segmentId: "team_context", requirements: [] }], "final_message");
    expect(result.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit -- eval-judge`
Expected: FAIL — cannot resolve `../eval-judge`.

- [ ] **Step 3: Write `eval-judge.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MODEL_ID,
  type EvalArtefactKind,
  type EvalLayerResult,
  type EvalVerdict,
  type PromptSegment,
  type RunEvalResult,
} from "@agentfactory/core";
import type { EvalArtefact } from "./eval-artefact";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Only human-authored layers are graded. Preamble, environment, and repo map are platform
// boilerplate — scoring the agent against them measures nothing about the team's context.
export const HUMAN_SEGMENT_IDS: ReadonlySet<string> = new Set(["team_context", "agent_system_prompt"]);

export function selectHumanSegments(segments: PromptSegment[]): PromptSegment[] {
  return segments.filter((segment) => HUMAN_SEGMENT_IDS.has(segment.id) && segment.text.trim() !== "");
}

// A 500 KB diff would blow the judge's context; cap the artefact and say so in the prompt.
// The cap is generous — a truncated verdict on a real diff beats a clean failure on size.
export const MAX_ARTEFACT_CHARS = 120_000;

export const JUDGE_MAX_TOKENS = 8_192;

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict compliance judge. You are given (1) instruction layers that were part of",
  "an AI coding agent's system prompt, and (2) the artefact that agent produced.",
  "",
  "For each layer, extract its concrete, checkable requirements. Skip aspirational or vague",
  'statements (e.g. "write good code") entirely — do not list them, do not fail them.',
  "",
  'Then judge each requirement against the artefact alone: verdict "pass" if the artefact',
  'demonstrably complies, "fail" if it demonstrably violates or omits it, "unclear" if the',
  "artefact does not show enough to decide. Never assume work happened outside the artefact.",
  "For evidence, quote the single most relevant line from the artefact, or state in one",
  "short sentence what is absent.",
  "",
  "Report exclusively through the report_eval tool.",
].join("\n");

const REPORT_EVAL_TOOL: Anthropic.Tool = {
  name: "report_eval",
  description: "Report the per-layer compliance verdicts for the artefact.",
  input_schema: {
    type: "object",
    required: ["layers"],
    properties: {
      layers: {
        type: "array",
        items: {
          type: "object",
          required: ["segmentId", "requirements"],
          properties: {
            segmentId: { type: "string", enum: ["team_context", "agent_system_prompt"] },
            requirements: {
              type: "array",
              items: {
                type: "object",
                required: ["text", "verdict", "evidence"],
                properties: {
                  text: { type: "string" },
                  verdict: { type: "string", enum: ["pass", "fail", "unclear"] },
                  evidence: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function buildJudgeUserMessage(segments: PromptSegment[], artefact: EvalArtefact): string {
  const layerBlocks = segments
    .map((segment) => `<layer id="${segment.id}">\n${segment.text}\n</layer>`)
    .join("\n\n");
  const truncated = artefact.text.length > MAX_ARTEFACT_CHARS;
  const body = truncated
    ? `${artefact.text.slice(0, MAX_ARTEFACT_CHARS)}\n…[artefact truncated]`
    : artefact.text;
  const kindLabel =
    artefact.kind === "diff"
      ? "the diff the agent's branch introduced"
      : "the agent's final reply message (it committed no code)";
  return `Instruction layers:\n\n${layerBlocks}\n\nThe artefact to judge — ${kindLabel}:\n\n<artefact>\n${body}\n</artefact>`;
}

const VERDICTS: ReadonlySet<string> = new Set(["pass", "fail", "unclear"]);

// The API's forced tool_choice already constrains the shape, but the eval fails cleanly on
// any drift rather than storing garbage — "it parses or the eval fails" (spec).
export function validateJudgeLayers(input: unknown): EvalLayerResult[] {
  const layers = (input as { layers?: unknown } | undefined)?.layers;
  if (!Array.isArray(layers)) throw new Error("judge output has no layers array");
  return layers.map((layer) => {
    const { segmentId, requirements } = (layer ?? {}) as { segmentId?: unknown; requirements?: unknown };
    if (typeof segmentId !== "string" || !HUMAN_SEGMENT_IDS.has(segmentId)) {
      throw new Error(`judge output has an invalid segmentId: ${String(segmentId)}`);
    }
    if (!Array.isArray(requirements)) throw new Error("judge output layer has no requirements array");
    return {
      segmentId,
      requirements: requirements.map((requirement) => {
        const { text, verdict, evidence } = (requirement ?? {}) as Record<string, unknown>;
        if (
          typeof text !== "string" ||
          typeof evidence !== "string" ||
          typeof verdict !== "string" ||
          !VERDICTS.has(verdict)
        ) {
          throw new Error("judge output requirement is malformed");
        }
        return { text, verdict: verdict as EvalVerdict, evidence };
      }),
    };
  });
}

// The score is computed here, never trusted from the model.
export function computeResult(layers: EvalLayerResult[], artefactKind: EvalArtefactKind): RunEvalResult {
  const requirements = layers.flatMap((layer) => layer.requirements);
  const passed = requirements.filter((requirement) => requirement.verdict === "pass").length;
  // Zero checkable requirements is a valid result, not an error — score 0 by the spec.
  const score = requirements.length === 0 ? 0 : passed / requirements.length;
  return { artefactKind, layers, score };
}

// One structured-output call: requirement extraction and verdicting in a single pass, the
// response forced into shape by tool_choice. Not unit-tested (network); everything around
// it is, and eval-runner injects it as a dependency.
export async function judgeCompliance(
  segments: PromptSegment[],
  artefact: EvalArtefact,
): Promise<{ result: RunEvalResult; judgeModelId: string }> {
  const response = await client.messages.create({
    model: DEFAULT_MODEL_ID,
    max_tokens: JUDGE_MAX_TOKENS,
    system: JUDGE_SYSTEM_PROMPT,
    tools: [REPORT_EVAL_TOOL],
    tool_choice: { type: "tool", name: "report_eval" },
    messages: [{ role: "user", content: buildJudgeUserMessage(segments, artefact) }],
  });
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("judge returned no report_eval tool call");
  const layers = validateJudgeLayers(toolUse.input);
  return { result: computeResult(layers, artefact.kind), judgeModelId: DEFAULT_MODEL_ID };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:unit -- eval-judge`
Expected: PASS (10 tests). Also `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/eval-judge.ts apps/worker/src/__tests__/eval-judge.test.ts
git commit -m "feat(worker): structured-output compliance judge"
```

---

### Task 7: Eval runner and worker wiring

**Files:**
- Create: `apps/worker/src/eval-runner.ts`
- Modify: `apps/worker/src/worker.ts` (fourth `Worker`, after the repo-map-warm worker ~line 365; extend the `@agentfactory/queue` import and the final `console.log`)
- Test: `apps/worker/src/__tests__/eval-runner.test.ts` (unit project)

**Interfaces:**
- Consumes: repository functions from Task 2 (`getRunEval`, `markEvalRunning`, `completeEval`, `failEval`) plus existing `getRun`, `getRunPrompt`, `getSession`, `getTaskBySessionId` from `@agentfactory/db`; `resolveEvalArtefact` / `ArtefactUnavailableError` / `EvalArtefact` from Task 5; `selectHumanSegments` / `judgeCompliance` from Task 6; `EVAL_QUEUE_NAME` / `EvalJobData` from Task 4.
- Produces: `processEvalJob(evalId: number, deps?: EvalRunnerDeps): Promise<void>` — the entire handler; `worker.ts` only passes `job.data.evalId` through.

- [ ] **Step 1: Write the failing tests**

`apps/worker/src/__tests__/eval-runner.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { PromptSegment, RunEval, RunEvalResult } from "@agentfactory/core";
import { ArtefactUnavailableError } from "../eval-artefact";
import { type EvalRunnerDeps, processEvalJob } from "../eval-runner";

const EVAL: RunEval = { id: 1, orgId: 2, runId: 7, status: "queued", createdAt: "2026-08-26T10:00:00.000Z" };
const SEGMENTS: PromptSegment[] = [
  { id: "platform_preamble", text: "You are an agent." },
  { id: "agent_system_prompt", text: "You are a reviewer." },
];
const RESULT: RunEvalResult = { artefactKind: "diff", layers: [], score: 0 };

function makeDeps(overrides: Partial<EvalRunnerDeps> = {}): EvalRunnerDeps {
  return {
    getRunEval: vi.fn().mockResolvedValue(EVAL),
    getRun: vi.fn().mockResolvedValue({ id: 7, sessionId: 12, status: "done" }),
    getRunPrompt: vi.fn().mockResolvedValue({ runId: 7, segments: SEGMENTS }),
    getSession: vi.fn().mockResolvedValue({ id: 12, orgId: 2, agentId: 3 }),
    getTaskBySessionId: vi.fn().mockResolvedValue({ id: 5, codebase: "acme/backend" }),
    markEvalRunning: vi.fn().mockResolvedValue(undefined),
    completeEval: vi.fn().mockResolvedValue(EVAL),
    failEval: vi.fn().mockResolvedValue(EVAL),
    resolveArtefact: vi.fn().mockResolvedValue({ kind: "diff", text: "+line" }),
    judge: vi.fn().mockResolvedValue({ result: RESULT, judgeModelId: "claude-sonnet-5" }),
    ...overrides,
  } as EvalRunnerDeps;
}

describe("processEvalJob", () => {
  it("marks running, judges the human segments against the artefact, and completes", async () => {
    const deps = makeDeps();
    await processEvalJob(1, deps);

    expect(deps.markEvalRunning).toHaveBeenCalledWith(1);
    // Only the human-authored layer reaches the judge.
    expect(deps.judge).toHaveBeenCalledWith(
      [{ id: "agent_system_prompt", text: "You are a reviewer." }],
      { kind: "diff", text: "+line" },
    );
    expect(deps.resolveArtefact).toHaveBeenCalledWith(7, { id: 12, orgId: 2, agentId: 3 }, { id: 5, codebase: "acme/backend" }, 2);
    expect(deps.completeEval).toHaveBeenCalledWith(1, RESULT, "claude-sonnet-5");
    expect(deps.failEval).not.toHaveBeenCalled();
  });

  it("fails run_never_composed_prompt when the run has no stored segments", async () => {
    const deps = makeDeps({ getRunPrompt: vi.fn().mockResolvedValue(undefined) });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "run_never_composed_prompt");
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it("fails no_human_context when only platform layers were sent", async () => {
    const deps = makeDeps({
      getRunPrompt: vi.fn().mockResolvedValue({ runId: 7, segments: [SEGMENTS[0]] }),
    });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "no_human_context");
  });

  it("fails artefact_unavailable when the artefact cannot be resolved", async () => {
    const deps = makeDeps({
      resolveArtefact: vi.fn().mockRejectedValue(new ArtefactUnavailableError("branch diff fetch failed")),
    });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "artefact_unavailable");
    expect(deps.judge).not.toHaveBeenCalled();
  });

  it("classifies an out-of-credits judge failure as insufficient_credit", async () => {
    const deps = makeDeps({
      judge: vi.fn().mockRejectedValue(new Error("Your credit balance is too low to access the Anthropic API")),
    });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "insufficient_credit");
  });

  it("classifies any other judge failure as judge_error", async () => {
    const deps = makeDeps({ judge: vi.fn().mockRejectedValue(new Error("overloaded")) });
    await processEvalJob(1, deps);
    expect(deps.failEval).toHaveBeenCalledWith(1, "judge_error");
  });

  it("drops the job quietly when the eval row is gone", async () => {
    const deps = makeDeps({ getRunEval: vi.fn().mockResolvedValue(undefined) });
    await processEvalJob(1, deps);
    expect(deps.markEvalRunning).not.toHaveBeenCalled();
    expect(deps.failEval).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit -- eval-runner`
Expected: FAIL — cannot resolve `../eval-runner`.

- [ ] **Step 3: Write `eval-runner.ts`**

```ts
import type { PromptSegment, Run, RunEval, RunEvalResult, Session, Task } from "@agentfactory/core";
import {
  completeEval,
  failEval,
  getRun,
  getRunEval,
  getRunPrompt,
  getSession,
  getTaskBySessionId,
  markEvalRunning,
} from "@agentfactory/db";
import { ArtefactUnavailableError, type EvalArtefact, resolveEvalArtefact } from "./eval-artefact";
import { judgeCompliance, selectHumanSegments } from "./eval-judge";

// Narrow function types rather than typeof imports so unit tests can stub each seam with a
// plain vi.fn() — the production defaults are structurally compatible.
export interface EvalRunnerDeps {
  getRunEval: (id: number) => Promise<RunEval | undefined>;
  getRun: (id: number) => Promise<Run | undefined>;
  getRunPrompt: (id: number) => Promise<{ segments: PromptSegment[] } | undefined>;
  getSession: (id: number) => Promise<Session | undefined>;
  getTaskBySessionId: (sessionId: number) => Promise<Task | undefined>;
  markEvalRunning: (id: number) => Promise<void>;
  completeEval: (id: number, result: RunEvalResult, judgeModelId: string) => Promise<RunEval>;
  failEval: (id: number, error: string) => Promise<RunEval>;
  resolveArtefact: (runId: number, session: Session, task: Task | undefined, orgId: number) => Promise<EvalArtefact>;
  judge: (segments: PromptSegment[], artefact: EvalArtefact) => Promise<{ result: RunEvalResult; judgeModelId: string }>;
}

const defaultDeps: EvalRunnerDeps = {
  getRunEval,
  getRun,
  getRunPrompt,
  getSession,
  getTaskBySessionId,
  markEvalRunning,
  completeEval,
  failEval,
  resolveArtefact: resolveEvalArtefact,
  judge: judgeCompliance,
};

function classifyJudgeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Same account-out-of-credits surface the run path classifies (#99) — the provider says
  // "credit balance is too low"; everything else is a generic judge failure.
  return message.toLowerCase().includes("credit balance") ? "insufficient_credit" : "judge_error";
}

// The spec's five steps, in order. Every failure ends as a `failed` row with one
// machine-readable reason — the row IS the failure record, so this never rethrows into
// BullMQ retries: the user re-triggers manually, and auto-retrying a judge call would
// only double-bill.
export async function processEvalJob(evalId: number, deps: EvalRunnerDeps = defaultDeps): Promise<void> {
  const evalRow = await deps.getRunEval(evalId);
  if (!evalRow) {
    // Cascade delete beat the job to it (run/session/org removed) — nothing left to grade
    // and no row to record a failure on.
    console.error(`Eval ${evalId} not found; dropping job`);
    return;
  }

  await deps.markEvalRunning(evalId);
  try {
    const run = await deps.getRun(evalRow.runId);
    if (!run) {
      await deps.failEval(evalId, "artefact_unavailable");
      return;
    }

    // 1. No stored prompt → the run failed before composing one; nothing to grade against.
    const prompt = await deps.getRunPrompt(run.id);
    const segments = prompt?.segments ?? [];
    if (segments.length === 0) {
      await deps.failEval(evalId, "run_never_composed_prompt");
      return;
    }

    // 2. Only human-authored layers are judged.
    const humanSegments = selectHumanSegments(segments);
    if (humanSegments.length === 0) {
      await deps.failEval(evalId, "no_human_context");
      return;
    }

    // 3. The artefact rule — diff or final message, never a silent fallback.
    const session = await deps.getSession(run.sessionId);
    if (!session) {
      await deps.failEval(evalId, "artefact_unavailable");
      return;
    }
    const task = await deps.getTaskBySessionId(session.id);
    let artefact: EvalArtefact;
    try {
      artefact = await deps.resolveArtefact(run.id, session, task, evalRow.orgId);
    } catch (err) {
      if (err instanceof ArtefactUnavailableError) {
        console.error(`Eval ${evalId}: ${err.message}`);
        await deps.failEval(evalId, "artefact_unavailable");
        return;
      }
      throw err;
    }

    // 4–5. One structured-output judge call; store result + judge model, mark done.
    const { result, judgeModelId } = await deps.judge(humanSegments, artefact);
    await deps.completeEval(evalId, result, judgeModelId);
  } catch (err) {
    console.error(`Eval ${evalId} failed:`, err);
    await deps.failEval(evalId, classifyJudgeError(err));
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:unit -- eval-runner`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire the fourth worker**

In `apps/worker/src/worker.ts`, extend the `@agentfactory/queue` import with `EVAL_QUEUE_NAME` and `type EvalJobData`, add `import { processEvalJob } from "./eval-runner";`, then after the repo-map-warm worker block:

```ts
// Triggered by the task page's Evaluate button (apps/web's /api/runs/[runId]/evals route) —
// grades a finished run's artefact against the human-authored prompt layers. Own queue so
// grading starts when the user clicks instead of waiting behind ~60s agent runs.
const evalWorker = new Worker<EvalJobData>(
  EVAL_QUEUE_NAME,
  async (job) => {
    await processEvalJob(job.data.evalId);
  },
  { connection: queueConnection },
);

evalWorker.on("failed", (job, err) => {
  console.error(`Eval job ${job?.id} failed:`, err);
});
```

Extend the closing log line to name all four queues:

```ts
console.log(
  `apps/worker listening on queues "${RUN_QUEUE_NAME}", "${SANDBOX_TEARDOWN_QUEUE_NAME}", "${REPO_MAP_WARM_QUEUE_NAME}", "${EVAL_QUEUE_NAME}"`,
);
```

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/eval-runner.ts apps/worker/src/worker.ts apps/worker/src/__tests__/eval-runner.test.ts
git commit -m "feat(worker): eval queue handler — resolve artefact, judge, store"
```

---

### Task 8: API routes

**Files:**
- Create: `apps/web/src/app/api/runs/[runId]/evals/route.ts`

**Interfaces:**
- Consumes: `createRunEval`, `listEvalsForRun` (Task 2), `getRun`, `getSession`, `getAgent` from `@agentfactory/db`; `enqueueEvalJob` (Task 4); `requireAuthContext` from `@/server/auth` (returns `{ user, orgId } | undefined`).
- Produces: `POST /api/runs/[runId]/evals` → 201 with the queued `RunEval` (409 when the run is not terminal, 404 when missing/cross-org, 401 unauthenticated); `GET /api/runs/[runId]/evals` → 200 with `RunEval[]` newest first. Consumed by Task 9's panel and Task 10's e2e.

Existing routes carry a documented tenant-isolation gap (no org check on runId). This route does NOT inherit it: evals are org-scoped by design, so both handlers resolve the run's org through session → agent and 404 on a mismatch.

- [ ] **Step 1: Write the route**

```ts
import { NextResponse } from "next/server";
import type { Run, RunStatus } from "@agentfactory/core";
import { createRunEval, getAgent, getRun, getSession, listEvalsForRun } from "@agentfactory/db";
import { enqueueEvalJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";

// Same three terminal statuses RunContextPanel treats as final.
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "failed", "cancelled"]);

// Resolves the run AND proves it belongs to the caller's org (runs → sessions → agents),
// closing — for this route — the tenant-isolation gap documented on the sibling run routes.
// A cross-org run answers 404, indistinguishable from a missing one.
async function loadRunForOrg(runId: number, orgId: number): Promise<Run | undefined> {
  if (!Number.isInteger(runId)) return undefined;
  const run = await getRun(runId);
  if (!run) return undefined;
  const session = await getSession(run.sessionId);
  if (!session) return undefined;
  const agent = await getAgent(session.agentId);
  if (!agent || agent.orgId !== orgId) return undefined;
  return run;
}

export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await loadRunForOrg(Number(runId), ctx.orgId);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (!TERMINAL_STATUSES.has(run.status)) {
    return NextResponse.json({ error: "Run is not finished" }, { status: 409 });
  }

  const runEval = await createRunEval(ctx.orgId, run.id);
  await enqueueEvalJob(runEval.id);
  return NextResponse.json(runEval, { status: 201 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await params;
  const run = await loadRunForOrg(Number(runId), ctx.orgId);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  return NextResponse.json(await listEvalsForRun(run.id, ctx.orgId));
}
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. (Route behavior is asserted end to end in Task 10's Playwright spec — the house pattern; sibling routes have no unit tests either.)

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/api/runs/[runId]/evals/route.ts"
git commit -m "feat(web): create/list eval routes with org-scoped run lookup"
```

---

### Task 9: i18n copy and `RunEvalPanel`

**Files:**
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` (inside `taskDetail`, after `contextLayerUnknown` ~line 288)
- Create: `apps/web/src/components/RunEvalPanel.tsx`
- Test: `apps/web/src/components/__tests__/RunEvalPanel.test.tsx` (unit project, jsdom pragma)

**Interfaces:**
- Consumes: `RunEval`, `RunEvalResult`, `Run`, `RunStatus` from core; `apiFetch<T>` from `@/lib/api-client`; `useTranslation` (`t(key, vars)` interpolates `{name}` placeholders); `EmptyState` from `@agentfactory/shared`; Task 8's routes.
- Produces (used by Task 10): `RunEvalPanel({ runs }: { runs: Run[] })` — same props as `RunContextPanel`.

- [ ] **Step 1: Add the i18n keys** (in `en.ts` `taskDetail`, after `contextLayerUnknown`)

```ts
evalTab: "Evaluation",
evalIntro:
  "Score this run's deliverable against the context it was given. The judge reads the human-authored prompt layers, extracts the checkable instructions, and verdicts each one with evidence.",
evalButton: "Evaluate",
evalButtonAgain: "Evaluate again",
evalDisabledNotTerminal: "Available once the run finishes",
evalDisabledNoPrompt: "This run has no recorded prompt to grade against",
evalNoRunsSub: "Each run can be evaluated against its context once it finishes.",
evalRunningLabel: "Evaluating…",
evalHeadline: "{passed} of {total} instructions followed",
evalNoRequirements: "The context contains no checkable instructions — nothing to grade.",
evalArtefactDiff: "Graded the branch diff",
evalArtefactFinalMessage: "Graded the final reply (no code was committed)",
evalJudgeStamp: "Judged by {model}",
evalFailedTitle: "Evaluation failed",
evalErrorRunNeverComposedPrompt: "This run failed before composing a prompt, so there is no context to grade.",
evalErrorNoHumanContext: "This run's prompt contained no human-authored context to grade.",
evalErrorArtefactUnavailable: "The run's deliverable could not be fetched, so nothing was graded.",
evalErrorInsufficientCredit: "The connected Claude API account has run out of usage credits.",
evalErrorGeneric: "The judge call failed. Try again.",
evalVerdictPass: "Followed",
evalVerdictFail: "Not followed",
evalVerdictUnclear: "Unclear",
evalEvidenceLabel: "Evidence",
evalHistoryLabel: "Previous evaluations",
evalLoadError: "Couldn't load evaluations for this run.",
evalRetry: "Try again",
```

- [ ] **Step 2: Write the failing component tests**

`apps/web/src/components/__tests__/RunEvalPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunEval } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { RunEvalPanel } from "../RunEvalPanel";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const DONE_RUN: Run[] = [
  { id: 7, sessionId: 1, status: "done", costUsd: 0, tokensUsed: 0, promptHash: "c".repeat(64), createdAt: "2026-08-26T10:00:00.000Z" } as Run,
];
const RUNNING_RUN: Run[] = [
  { id: 8, sessionId: 1, status: "running", costUsd: 0, tokensUsed: 0, createdAt: "2026-08-26T10:00:00.000Z" } as Run,
];

const DONE_EVAL: RunEval = {
  id: 31,
  orgId: 1,
  runId: 7,
  status: "done",
  judgeModelId: "claude-sonnet-5",
  createdAt: "2026-08-26T11:00:00.000Z",
  completedAt: "2026-08-26T11:00:20.000Z",
  result: {
    artefactKind: "diff",
    score: 0.5,
    layers: [
      {
        segmentId: "team_context",
        requirements: [
          { text: "Use conventional commits", verdict: "pass", evidence: "feat: add parser" },
          { text: "Update the changelog", verdict: "fail", evidence: "No CHANGELOG edit in the diff" },
        ],
      },
    ],
  },
};

function renderPanel(runs: Run[] = DONE_RUN) {
  return render(
    <I18nProvider>
      <RunEvalPanel runs={runs} />
    </I18nProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

describe("RunEvalPanel", () => {
  it("renders an empty state when the session has no runs", () => {
    renderPanel([]);
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });

  it("shows the intro and an enabled Evaluate button for a finished run with no evals", async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    renderPanel();
    expect(await screen.findByRole("button", { name: "Evaluate" })).toBeEnabled();
    expect(screen.getByText(/Score this run's deliverable/)).toBeInTheDocument();
  });

  it("disables the button with a reason while the run is still active", async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    renderPanel(RUNNING_RUN);
    expect(await screen.findByRole("button", { name: "Evaluate" })).toBeDisabled();
    expect(screen.getByText("Available once the run finishes")).toBeInTheDocument();
  });

  it("shows the running treatment for a queued eval", async () => {
    apiFetchMock.mockResolvedValue([{ ...DONE_EVAL, status: "queued", result: undefined, completedAt: undefined }]);
    renderPanel();
    expect(await screen.findByText("Evaluating…")).toBeInTheDocument();
  });

  it("renders a done card: headline, artefact, verdicts, evidence, judge stamp", async () => {
    apiFetchMock.mockResolvedValueOnce([DONE_EVAL]);
    renderPanel();
    expect(await screen.findByText("1 of 2 instructions followed")).toBeInTheDocument();
    expect(screen.getByText("Graded the branch diff")).toBeInTheDocument();
    expect(screen.getByText("Use conventional commits")).toBeInTheDocument();
    expect(screen.getByText("Not followed")).toBeInTheDocument();
    expect(screen.getByText(/No CHANGELOG edit in the diff/)).toBeInTheDocument();
    expect(screen.getByText("Judged by claude-sonnet-5")).toBeInTheDocument();
  });

  it("states plainly when nothing was checkable", async () => {
    apiFetchMock.mockResolvedValueOnce([
      { ...DONE_EVAL, result: { artefactKind: "final_message", score: 0, layers: [] } },
    ]);
    renderPanel();
    expect(await screen.findByText(/no checkable instructions/)).toBeInTheDocument();
  });

  it("renders a failed card with the mapped reason and the button again", async () => {
    apiFetchMock.mockResolvedValueOnce([
      { ...DONE_EVAL, status: "failed", result: undefined, error: "artefact_unavailable" },
    ]);
    renderPanel();
    expect(await screen.findByText(/could not be fetched/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Evaluate again" })).toBeEnabled();
  });

  it("lists older evals under a history heading, newest card first", async () => {
    const older: RunEval = { ...DONE_EVAL, id: 30, createdAt: "2026-08-26T09:00:00.000Z" };
    apiFetchMock.mockResolvedValueOnce([DONE_EVAL, older]);
    renderPanel();
    expect(await screen.findByText("Previous evaluations")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 instructions followed")).toBeInTheDocument();
  });

  it("POSTs a new eval and refreshes the list when Evaluate is clicked", async () => {
    apiFetchMock.mockResolvedValueOnce([]); // initial GET
    renderPanel();
    const button = await screen.findByRole("button", { name: "Evaluate" });

    apiFetchMock.mockResolvedValueOnce({ ...DONE_EVAL, status: "queued", result: undefined }); // POST
    apiFetchMock.mockResolvedValue([{ ...DONE_EVAL, status: "queued", result: undefined }]); // refresh GET
    fireEvent.click(button);

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/runs/7/evals", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findByText("Evaluating…")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test:unit -- RunEvalPanel`
Expected: FAIL — cannot resolve `../RunEvalPanel`.

- [ ] **Step 4: Write the component**

`apps/web/src/components/RunEvalPanel.tsx` — modeled on `RunContextPanel` (same props, same run-selector derivation, same fetch-state map). Poll `GET` every 3s only while the shown run has a queued/running eval:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalRequirement, Run, RunEval, RunStatus } from "@agentfactory/core";
import { EmptyState } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

const LAYER_LABEL_KEYS: Record<string, TranslationKey> = {
  team_context: "taskDetail.contextLayerTeamContext",
  agent_system_prompt: "taskDetail.contextLayerAgentSystemPrompt",
};

// error column values → copy. Unknown codes (future reasons) fall through to the generic line.
const ERROR_LABEL_KEYS: Record<string, TranslationKey> = {
  run_never_composed_prompt: "taskDetail.evalErrorRunNeverComposedPrompt",
  no_human_context: "taskDetail.evalErrorNoHumanContext",
  artefact_unavailable: "taskDetail.evalErrorArtefactUnavailable",
  insufficient_credit: "taskDetail.evalErrorInsufficientCredit",
};

const VERDICT_LABEL_KEYS: Record<EvalRequirement["verdict"], TranslationKey> = {
  pass: "taskDetail.evalVerdictPass",
  fail: "taskDetail.evalVerdictFail",
  unclear: "taskDetail.evalVerdictUnclear",
};

const VERDICT_MARKS: Record<EvalRequirement["verdict"], { mark: string; color: string }> = {
  pass: { mark: "✓", color: "var(--color-success, #22c55e)" },
  fail: { mark: "✗", color: "var(--color-danger, #ef4444)" },
  unclear: { mark: "?", color: "var(--color-neutral-500)" },
};

// Same three statuses RunContextPanel treats as final — the POST guard mirrors this server-side.
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "failed", "cancelled"]);
const ACTIVE_EVAL_STATUSES = new Set<RunEval["status"]>(["queued", "running"]);
const POLL_MS = 3000;

type EvalFetchState = { status: "error" } | { status: "loaded"; evals: RunEval[] };

function countVerdicts(runEval: RunEval): { passed: number; total: number } {
  const requirements = runEval.result?.layers.flatMap((layer) => layer.requirements) ?? [];
  return { passed: requirements.filter((r) => r.verdict === "pass").length, total: requirements.length };
}

export function RunEvalPanel({ runs }: { runs: Run[] }) {
  const { t } = useTranslation();
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [evalsByRun, setEvalsByRun] = useState<Map<number, EvalFetchState>>(new Map());
  const [creating, setCreating] = useState(false);
  // Guards the initial fetch per run — the poll below handles refreshes (see RunContextPanel
  // for why this is a ref and not state).
  const requestedRunIds = useRef<Set<number>>(new Set());

  const shownRunId = selectedRunId ?? runs[0]?.id ?? null;
  const shownRun = runs.find((run) => run.id === shownRunId);

  const fetchEvals = useCallback(async (runId: number) => {
    try {
      const evals = await apiFetch<RunEval[]>(`/api/runs/${runId}/evals`);
      setEvalsByRun((prev) => new Map(prev).set(runId, { status: "loaded", evals }));
    } catch {
      setEvalsByRun((prev) => new Map(prev).set(runId, { status: "error" }));
    }
  }, []);

  useEffect(() => {
    if (shownRunId === null || requestedRunIds.current.has(shownRunId)) return;
    requestedRunIds.current.add(shownRunId);
    void fetchEvals(shownRunId);
  }, [shownRunId, fetchEvals]);

  const fetchState = shownRunId !== null ? evalsByRun.get(shownRunId) : undefined;
  const evals = fetchState?.status === "loaded" ? fetchState.evals : [];
  const hasActiveEval = evals.some((e) => ACTIVE_EVAL_STATUSES.has(e.status));

  // Poll only while an eval is queued/running — the card flips to done/failed on its own.
  useEffect(() => {
    if (shownRunId === null || !hasActiveEval) return;
    const timer = setInterval(() => void fetchEvals(shownRunId), POLL_MS);
    return () => clearInterval(timer);
  }, [shownRunId, hasActiveEval, fetchEvals]);

  if (runs.length === 0) {
    return <EmptyState icon="📊" title={t("taskDetail.contextNoRuns")} subtitle={t("taskDetail.evalNoRunsSub")} />;
  }

  const runIsTerminal = shownRun ? TERMINAL_STATUSES.has(shownRun.status) : false;
  const runHasPrompt = Boolean(shownRun?.promptHash);
  const canEvaluate = runIsTerminal && runHasPrompt && !hasActiveEval && !creating;
  const disabledReason = !runIsTerminal
    ? t("taskDetail.evalDisabledNotTerminal")
    : !runHasPrompt
      ? t("taskDetail.evalDisabledNoPrompt")
      : null;

  const startEval = async () => {
    if (shownRunId === null) return;
    setCreating(true);
    try {
      await apiFetch<RunEval>(`/api/runs/${shownRunId}/evals`, { method: "POST" });
      await fetchEvals(shownRunId);
    } catch {
      setEvalsByRun((prev) => new Map(prev).set(shownRunId, { status: "error" }));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", fontSize: 13 }}>
      {runs.length > 1 && (
        <select
          value={shownRunId ?? undefined}
          onChange={(e) => setSelectedRunId(Number(e.target.value))}
          style={{ marginBottom: 16 }}
        >
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {t("taskDetail.contextRunLabel")} #{run.id} · {run.status}
            </option>
          ))}
        </select>
      )}

      {fetchState?.status === "error" ? (
        <div>
          <p style={{ color: "var(--color-neutral-500)" }}>{t("taskDetail.evalLoadError")}</p>
          <button onClick={() => shownRunId !== null && void fetchEvals(shownRunId)}>{t("taskDetail.evalRetry")}</button>
        </div>
      ) : (
        <>
          {evals.length === 0 && (
            <p style={{ color: "var(--color-neutral-500)", maxWidth: 560, marginBottom: 12 }}>
              {t("taskDetail.evalIntro")}
            </p>
          )}
          {!hasActiveEval && (
            <div style={{ marginBottom: 20 }}>
              <button onClick={() => void startEval()} disabled={!canEvaluate}>
                {evals.length === 0 ? t("taskDetail.evalButton") : t("taskDetail.evalButtonAgain")}
              </button>
              {disabledReason && (
                <p style={{ color: "var(--color-neutral-500)", marginTop: 6 }}>{disabledReason}</p>
              )}
            </div>
          )}
          {evals.map((runEval, index) => (
            <EvalCard key={runEval.id} runEval={runEval} collapsed={index > 0} isFirstOlder={index === 1} />
          ))}
        </>
      )}
    </div>
  );
}

function EvalCard({ runEval, collapsed, isFirstOlder }: { runEval: RunEval; collapsed: boolean; isFirstOlder: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!collapsed);
  const { passed, total } = countVerdicts(runEval);

  const headline =
    runEval.status === "queued" || runEval.status === "running"
      ? t("taskDetail.evalRunningLabel")
      : runEval.status === "failed"
        ? t("taskDetail.evalFailedTitle")
        : total === 0
          ? t("taskDetail.evalNoRequirements")
          : t("taskDetail.evalHeadline", { passed, total });

  return (
    <div style={{ border: "1px solid var(--color-divider)", borderRadius: 8, padding: 16, marginBottom: 12 }}>
      {isFirstOlder && (
        <p style={{ color: "var(--color-neutral-500)", margin: "0 0 8px" }}>{t("taskDetail.evalHistoryLabel")}</p>
      )}
      <button
        onClick={() => setOpen((prev) => !prev)}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 600, fontSize: 13 }}
      >
        {headline}
      </button>
      <p style={{ color: "var(--color-neutral-500)", margin: "4px 0 0", fontSize: 12 }}>
        {new Date(runEval.createdAt).toLocaleString()}
        {runEval.judgeModelId ? ` · ${t("taskDetail.evalJudgeStamp", { model: runEval.judgeModelId })}` : ""}
      </p>

      {open && runEval.status === "failed" && (
        <p style={{ marginTop: 8 }}>
          {t(ERROR_LABEL_KEYS[runEval.error ?? ""] ?? "taskDetail.evalErrorGeneric")}
        </p>
      )}

      {open && runEval.status === "done" && runEval.result && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: "var(--color-neutral-500)", margin: "0 0 8px" }}>
            {runEval.result.artefactKind === "diff"
              ? t("taskDetail.evalArtefactDiff")
              : t("taskDetail.evalArtefactFinalMessage")}
          </p>
          {runEval.result.layers.map((layer) => (
            <div key={layer.segmentId} style={{ marginBottom: 12 }}>
              <p style={{ fontWeight: 600, margin: "0 0 6px" }}>
                {t(LAYER_LABEL_KEYS[layer.segmentId] ?? "taskDetail.contextLayerUnknown")}
              </p>
              {layer.requirements.map((requirement, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <span style={{ color: VERDICT_MARKS[requirement.verdict].color, fontWeight: 700 }}>
                    {VERDICT_MARKS[requirement.verdict].mark}
                  </span>
                  <div>
                    <p style={{ margin: 0 }}>
                      {requirement.text}{" "}
                      <span style={{ color: "var(--color-neutral-500)" }}>
                        — {t(VERDICT_LABEL_KEYS[requirement.verdict])}
                      </span>
                    </p>
                    {requirement.evidence && (
                      <p style={{ margin: "2px 0 0", color: "var(--color-neutral-500)", fontStyle: "italic" }}>
                        {t("taskDetail.evalEvidenceLabel")}: {requirement.evidence}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm test:unit -- RunEvalPanel`
Expected: PASS (9 tests). Adjust markup only if a query genuinely can't match; keep the copy assertions exactly as written — they pin the i18n keys.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/i18n/dictionaries/en.ts apps/web/src/components/RunEvalPanel.tsx apps/web/src/components/__tests__/RunEvalPanel.test.tsx
git commit -m "feat(web): RunEvalPanel with full state coverage"
```

---

### Task 10: Tab wiring, e2e, and final verification

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` (`activeTab` union ~line 61; tab bar after the Context `TabBtn` ~line 719; render next to the `RunContextPanel` line ~line 1035; add the import)
- Create: `apps/web/e2e/run-eval.spec.ts`

**Interfaces:**
- Consumes: `RunEvalPanel` (Task 9), `t("taskDetail.evalTab")`, existing `sessionRuns` state, Task 8's routes, the `registeredUser` Playwright fixture.
- Produces: the shipped feature.

- [ ] **Step 1: Wire the tab**

Extend the state union:

```ts
const [activeTab, setActiveTab] = useState<"transcript" | "files" | "context" | "evals">("transcript");
```

After the Context `TabBtn` (both are gated on `session`, so keep them adjacent):

```tsx
{session && (
  <TabBtn active={activeTab === "evals"} onClick={() => setActiveTab("evals")}>
    {t("taskDetail.evalTab")}
  </TabBtn>
)}
```

Next to the Context render line:

```tsx
{activeTab === "evals" && <RunEvalPanel runs={sessionRuns} />}
```

And import alongside `RunContextPanel`:

```ts
import { RunEvalPanel } from "@/components/RunEvalPanel";
```

- [ ] **Step 2: Write the e2e spec**

`apps/web/e2e/run-eval.spec.ts`:

```ts
import { expect, test } from "./fixtures";

// Same environment note as run-context.spec.ts: for a local run, export the scratch test
// database first (set -a && . ./.env.test.local && set +a && pnpm test:e2e); CI already does.
//
// No worker runs during e2e, so a run can never reach a terminal status here. The honest
// end-to-end assertions are therefore: the POST route's terminal-status guard answers 409,
// the Evaluation tab renders the GET route's real (empty) answer through the auth gate, and
// the button is disabled with its stated reason while the run is active. The full card state
// machine is covered by RunEvalPanel's component tests with the API mocked, and the judge
// itself is deliberately never exercised in CI (grading quality is not asserted, per spec).
test("the Evaluation tab renders and the eval routes answer", async ({ page, registeredUser }) => {
  const agentRes = await page.request.post("/api/agents", {
    data: { name: "Eval bot", description: "", systemPrompt: "Do eval work.", mode: "manual" },
  });
  expect(agentRes.ok()).toBeTruthy();
  const agent = await agentRes.json();

  const taskRes = await page.request.post("/api/tasks", {
    data: { title: "Eval tab task", assigneeAgentId: agent.id },
  });
  expect(taskRes.ok()).toBeTruthy();
  const task = await taskRes.json();

  // Creates the session and its first (queued) run; the response carries runId.
  const runRes = await page.request.post(`/api/tasks/${task.id}/run`);
  expect(runRes.ok()).toBeTruthy();
  const { runId } = await runRes.json();

  // The POST guard end to end: a queued run is not evaluable.
  const evalRes = await page.request.post(`/api/runs/${runId}/evals`);
  expect(evalRes.status()).toBe(409);

  await page.goto(`/tasks/${task.id}`);

  const listResponse = page.waitForResponse(
    (res) => /\/api\/runs\/\d+\/evals$/.test(res.url()) && res.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Evaluation" }).click();

  const response = await listResponse;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual([]);

  await expect(page.getByRole("button", { name: "Evaluate", exact: true })).toBeDisabled();
  await expect(page.getByText("Available once the run finishes")).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e spec**

Run: `set -a && . ./.env.test.local && set +a && pnpm test:e2e -- run-eval`
Expected: PASS. (If `.env.test.local` is absent in this worktree, copy it from the main checkout — see the comment block in `run-context.spec.ts`.)

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:db && pnpm test:queue`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/tasks/[taskId]/page.tsx" apps/web/e2e/run-eval.spec.ts
git commit -m "feat(web): Evaluation tab on the task page, with e2e coverage"
```

---

## Spec coverage map (self-review)

| Spec section | Task |
|---|---|
| Types (`domain.ts`) | 1 |
| Storage (`run_evals` + repository) | 2 |
| Queue (fourth queue, `{evalId}`) | 4 |
| Worker step 1–2 (prompt/human-segment guards) | 6 (`selectHumanSegments`), 7 (guards) |
| Worker step 3 (artefact rule, refuse-to-fall-back) | 3 (final message query), 5 |
| Worker step 4–5 (structured judge call, store) | 6, 7 |
| API (POST guard + GET list, org-scoped) | 8 |
| UI (fourth tab, 5 states, i18n) | 9, 10 |
| Tests (unit / db / component / e2e; grading quality not asserted) | every task; e2e honesty note in Task 10 |
| Out of scope (no auto-eval, no configurable judge, no comparison UI, no retention) | nothing implements them |
