# Run Prompt Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every run's assembled system prompt as ordered labeled segments (byte-identical to what the model received) and surface it in a new **Context** tab on the task page, including "layer omitted because X" rows.

**Architecture:** `composeSystemPrompt` (worker) returns `{ segments, prompt }` where `prompt` is exactly the segment texts joined — one source of truth. Segments are stored in a new nullable `runs.prompt_segments` jsonb column, written in the same `updateRunStatus` call that already stores `prompt_hash`. Reads go through a dedicated narrow repository function + `GET /api/runs/[runId]/prompt` endpoint, fetched lazily by the Context tab — segments are **never** added to the `Run` type, so they can't ride the task page's status polls.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Next.js App Router route handlers, Vitest, React client components with the repo's inline-style + CSS-variable conventions.

**Spec:** `docs/superpowers/specs/2026-08-26-run-prompt-visibility-design.md` — read it first.

## Global Constraints

- The model must receive **byte-for-byte the same prompt as before this change** for identical inputs. Only recording is added.
- Segments never appear on the `Run` domain type or in `toRun` — dedicated type + dedicated read only.
- All user-facing strings go through `useTranslation()` / `en.ts` (typed keys). No hardcoded UI copy.
- `agents.systemPrompt` is stored in full, never truncated.
- Test commands: `pnpm test:unit` (worker/core unit tests), `pnpm test:db` (db integration — needs `DATABASE_URL` via `.env.test.local`, see `packages/db/src/__tests__/setup.ts`). Typecheck: `pnpm typecheck`. Lint: `pnpm lint`.
- Migrations: edit `packages/db/src/schema.ts`, then `pnpm --filter @agentfactory/db db:generate` (drizzle-kit creates the SQL file; commit it together with the schema change).

---

### Task 1: Domain types + segment-returning `composeSystemPrompt`

**Files:**
- Modify: `packages/core/src/domain.ts` (append near the `Run` interface, ~line 235)
- Modify: `apps/worker/src/prompt-composition.ts` (replace `composeSystemPrompt`, add two segment builders)
- Test: `apps/worker/src/__tests__/prompt-composition.test.ts`

**Interfaces:**
- Consumes: existing `PLATFORM_PREAMBLE`, `formatEnvironmentForPrompt`, `hashPrompt` (unchanged).
- Produces (later tasks rely on these exact names):
  - `PromptOmissionReason`, `PromptSegment`, `RunPrompt` exported from `@agentfactory/core`
  - `composeSystemPrompt(environment: string, teamContext: PromptSegment, repoMap: PromptSegment, agentSystemPrompt: string): ComposedPrompt` where `ComposedPrompt = { segments: PromptSegment[]; prompt: string }`
  - `buildTeamContextSegment(hasTeam: boolean, formatted: string): PromptSegment`
  - `buildRepoMapSegment(hasCodebase: boolean, wrapped: string): PromptSegment`

- [ ] **Step 1: Add the domain types**

In `packages/core/src/domain.ts`, after the `Run` interface:

```ts
// ── Run prompt record ───────────────────────────────────────────────────────────
// Why a given prompt layer contributed nothing to this run. Machine-readable; the
// web app maps codes to i18n strings and renders unknown codes as a generic
// "not included" — adding a code is never a breaking change.
export type PromptOmissionReason =
  | "no_team"
  | "empty_shared_context"
  | "no_codebase"
  | "repo_map_pending";

// One layer of a run's composed system prompt. Invariant (tested in
// prompt-composition.test.ts): joining segment texts in order reproduces the
// exact string the model received. `id` is a stable layer id
// ("platform_preamble" | "environment" | "team_context" | "repo_map" |
// "agent_system_prompt" today) typed as string so old clients render future
// layers without a core bump.
export interface PromptSegment {
  id: string;
  text: string;
  omittedReason?: PromptOmissionReason;
}

// The stored prompt record for one run — served by GET /api/runs/[runId]/prompt.
// Deliberately NOT part of Run: the task page polls run status on a timer, and
// this payload is up to ~80 KB.
export interface RunPrompt {
  runId: ID;
  segments: PromptSegment[];
  // Optional because the column is independently nullable: nothing in the schema
  // forces prompt_hash and prompt_segments to be written together, so the type
  // admits the state the database can actually hold rather than fabricating "".
  promptHash?: string;
}
```

Verify `packages/core/src/index.ts` re-exports `domain.ts` (it exports everything today — only add an export line if the new types don't resolve).

- [ ] **Step 2: Write the failing tests**

In `apps/worker/src/__tests__/prompt-composition.test.ts`, add `buildRepoMapSegment, buildTeamContextSegment` to the existing import from `../prompt-composition`, and update the three existing `composeSystemPrompt` tests to the new signature (they currently pass four strings and treat the result as a string):

```ts
import type { PromptSegment } from "@agentfactory/core";

const teamSeg = (text: string): PromptSegment => ({ id: "team_context", text });
const repoSeg = (text: string): PromptSegment => ({ id: "repo_map", text });

describe("composeSystemPrompt", () => {
  it("orders platform preamble, then environment, then team context, then repo map, then agent system prompt", () => {
    const { prompt } = composeSystemPrompt(
      "## Environment\n\nCheckout is at /workspace.\n\n---\n\n",
      teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"),
      repoSeg("## Repo Map\n\nThis is a monorepo.\n\n---\n\n"),
      "You are a reviewer.",
    );

    const preambleIndex = prompt.indexOf(PLATFORM_PREAMBLE);
    const environmentIndex = prompt.indexOf("Checkout is at /workspace.");
    const teamIndex = prompt.indexOf("Use pnpm.");
    const repoMapIndex = prompt.indexOf("This is a monorepo.");
    const agentIndex = prompt.indexOf("You are a reviewer.");

    expect(preambleIndex).toBe(0);
    expect(environmentIndex).toBeGreaterThan(preambleIndex);
    expect(teamIndex).toBeGreaterThan(environmentIndex);
    expect(repoMapIndex).toBeGreaterThan(teamIndex);
    expect(agentIndex).toBeGreaterThan(repoMapIndex);
  });

  it("still leads with the platform preamble when every optional section is empty", () => {
    const { prompt } = composeSystemPrompt("", teamSeg(""), repoSeg(""), "You are a reviewer.");
    expect(prompt).toBe(PLATFORM_PREAMBLE + "You are a reviewer.");
  });

  it("omits the repo map cleanly when empty, without changing prior behavior", () => {
    const { prompt } = composeSystemPrompt(
      "",
      teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"),
      repoSeg(""),
      "You are a reviewer.",
    );
    expect(prompt).toBe(PLATFORM_PREAMBLE + "## Team Context\n\nUse pnpm.\n\n---\n\n" + "You are a reviewer.");
  });

  // The core guarantee of the whole feature: the stored record IS the sent prompt.
  it("returns segments whose joined texts are byte-identical to the prompt, for every omission combination", () => {
    const cases = [
      { team: teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"), repo: repoSeg("## Repo Map\n\nMonorepo.\n\n---\n\n") },
      { team: { id: "team_context", text: "", omittedReason: "no_team" as const }, repo: repoSeg("## Repo Map\n\nMonorepo.\n\n---\n\n") },
      { team: teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"), repo: { id: "repo_map", text: "", omittedReason: "no_codebase" as const } },
      { team: { id: "team_context", text: "", omittedReason: "empty_shared_context" as const }, repo: { id: "repo_map", text: "", omittedReason: "repo_map_pending" as const } },
    ];
    for (const c of cases) {
      const { segments, prompt } = composeSystemPrompt("## Environment\n\n---\n\n", c.team, c.repo, "You are a reviewer.");
      expect(segments.map((s) => s.text).join("")).toBe(prompt);
      expect(segments.map((s) => s.id)).toEqual([
        "platform_preamble",
        "environment",
        "team_context",
        "repo_map",
        "agent_system_prompt",
      ]);
    }
  });

  it("passes the caller's omission reasons through and never marks unconditional segments omitted", () => {
    const { segments } = composeSystemPrompt(
      "",
      { id: "team_context", text: "", omittedReason: "no_team" },
      { id: "repo_map", text: "", omittedReason: "no_codebase" },
      "You are a reviewer.",
    );
    const byId = new Map(segments.map((s) => [s.id, s]));
    expect(byId.get("team_context")?.omittedReason).toBe("no_team");
    expect(byId.get("repo_map")?.omittedReason).toBe("no_codebase");
    expect(byId.get("platform_preamble")?.omittedReason).toBeUndefined();
    expect(byId.get("environment")?.omittedReason).toBeUndefined();
    expect(byId.get("agent_system_prompt")?.omittedReason).toBeUndefined();
  });
});

describe("segment builders", () => {
  it("buildTeamContextSegment distinguishes no-team from empty shared context", () => {
    expect(buildTeamContextSegment(false, "")).toEqual({ id: "team_context", text: "", omittedReason: "no_team" });
    expect(buildTeamContextSegment(true, "")).toEqual({ id: "team_context", text: "", omittedReason: "empty_shared_context" });
    expect(buildTeamContextSegment(true, "## Team Context\n\nUse pnpm.\n\n---\n\n")).toEqual({
      id: "team_context",
      text: "## Team Context\n\nUse pnpm.\n\n---\n\n",
    });
  });

  it("buildRepoMapSegment distinguishes chat-only sessions from a pending map", () => {
    expect(buildRepoMapSegment(false, "")).toEqual({ id: "repo_map", text: "", omittedReason: "no_codebase" });
    expect(buildRepoMapSegment(true, "")).toEqual({ id: "repo_map", text: "", omittedReason: "repo_map_pending" });
    expect(buildRepoMapSegment(true, "## Repo Map\n\nMonorepo.\n\n---\n\n")).toEqual({
      id: "repo_map",
      text: "## Repo Map\n\nMonorepo.\n\n---\n\n",
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:unit -- prompt-composition`
Expected: FAIL — `composeSystemPrompt` returns a string (`.prompt` undefined), `buildTeamContextSegment`/`buildRepoMapSegment` not exported.

- [ ] **Step 4: Implement**

In `apps/worker/src/prompt-composition.ts`, add the import and replace `composeSystemPrompt`:

```ts
import type { PromptSegment } from "@agentfactory/core";

export interface ComposedPrompt {
  segments: PromptSegment[];
  prompt: string; // invariant: segments.map((s) => s.text).join("")
}

// Team-context segment for a run. The worker is the only place that knows WHY the
// layer is empty — no team at all vs. a team whose shared context is blank — and
// those are different bugs, so the reason is recorded here, not inferred in the UI.
export function buildTeamContextSegment(hasTeam: boolean, formatted: string): PromptSegment {
  if (formatted) return { id: "team_context", text: formatted };
  return { id: "team_context", text: "", omittedReason: hasTeam ? "empty_shared_context" : "no_team" };
}

// Repo-map segment: chat-only session (no codebase) vs. cache miss with
// generation deferred to a background job (see repo-map.ts).
export function buildRepoMapSegment(hasCodebase: boolean, wrapped: string): PromptSegment {
  if (wrapped) return { id: "repo_map", text: wrapped };
  return { id: "repo_map", text: "", omittedReason: hasCodebase ? "repo_map_pending" : "no_codebase" };
}

// Order per ARCHITECTURE.md §3 (see the pre-existing comment above). Returns the
// segments alongside the joined prompt so the caller can persist exactly what was
// sent (runs.prompt_segments) — `prompt` is derived from `segments`, never built
// separately, so the stored record cannot drift from the sent string.
export function composeSystemPrompt(
  environment: string,
  teamContext: PromptSegment,
  repoMap: PromptSegment,
  agentSystemPrompt: string,
): ComposedPrompt {
  const segments: PromptSegment[] = [
    { id: "platform_preamble", text: PLATFORM_PREAMBLE },
    { id: "environment", text: environment },
    teamContext,
    repoMap,
    { id: "agent_system_prompt", text: agentSystemPrompt },
  ];
  return { segments, prompt: segments.map((s) => s.text).join("") };
}
```

Keep the existing comment block above `composeSystemPrompt`; do not change `PLATFORM_PREAMBLE`, `formatEnvironmentForPrompt`, or `hashPrompt`.

- [ ] **Step 5: Fix the one call site so the worker compiles**

`apps/worker/src/worker.ts:184-185` currently reads:

```ts
const systemPrompt = composeSystemPrompt(environment, teamContextPrefix, repoMap, agent.systemPrompt);
await updateRunStatus(runId, "running", { promptHash: hashPrompt(systemPrompt) });
```

Replace with (segment persistence itself lands in Task 3 — this step only adapts to the new signature):

```ts
const composed = composeSystemPrompt(
  environment,
  buildTeamContextSegment(Boolean(team), teamContextPrefix),
  buildRepoMapSegment(Boolean(task?.codebase), repoMap),
  agent.systemPrompt,
);
const systemPrompt = composed.prompt;
await updateRunStatus(runId, "running", { promptHash: hashPrompt(systemPrompt) });
```

Add `buildRepoMapSegment, buildTeamContextSegment` to the existing `./prompt-composition` import in `worker.ts`. Note `team` is declared at `worker.ts:165` (`const team = agent.teamId ? await getTeam(agent.teamId) : undefined;`) — `Boolean(team)` covers both "no teamId" and "team lookup returned undefined"; both mean the layer had no team to draw from, and only the formatted-empty case maps to `empty_shared_context`. `systemPrompt` is used further down the function (it goes into the turn env) — keep that variable name.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm test:unit -- prompt-composition` — Expected: PASS
Run: `pnpm typecheck` — Expected: clean (this catches any other `composeSystemPrompt` call site; the repo has exactly one, in `worker.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/domain.ts apps/worker/src/prompt-composition.ts apps/worker/src/__tests__/prompt-composition.test.ts apps/worker/src/worker.ts
git commit -m "Return labeled segments from composeSystemPrompt with omission reasons"
```

---

### Task 2: `runs.prompt_segments` column + repository write/read

**Files:**
- Modify: `packages/db/src/schema.ts` (the `runs` table, after `workspaceSnapshot`, ~line 220)
- Modify: `packages/db/src/repositories/runs.ts`
- Create: `packages/db/drizzle/00XX_*.sql` via `pnpm --filter @agentfactory/db db:generate` (never hand-write)
- Test: `packages/db/src/__tests__/repositories/messages-runs-events.test.ts`

**Interfaces:**
- Consumes: `PromptSegment`, `RunPrompt` from `@agentfactory/core` (Task 1).
- Produces (Task 3 and 4 rely on these):
  - `updateRunStatus(id, status, patch?)` — patch type gains `promptSegments?: PromptSegment[]`
  - `getRunPrompt(id: number): Promise<RunPrompt | undefined>` exported from `@agentfactory/db` — `undefined` when the run doesn't exist **or** has no stored segments
- `toRun` and the `Run` type are NOT touched — that's the point.

- [ ] **Step 1: Write the failing tests**

In `packages/db/src/__tests__/repositories/messages-runs-events.test.ts`, add `getRunPrompt` to the `repositories/runs.js` import and add inside `describe("runs repository", ...)`:

```ts
it("stores prompt segments with the status update and reads them back via getRunPrompt only", async () => {
  const session = await setupSession();
  const run = await createRun(session.id);
  const promptHash = "b".repeat(64);
  const segments = [
    { id: "platform_preamble", text: "You are an agent.\n\n---\n\n" },
    { id: "team_context", text: "", omittedReason: "no_team" as const },
    { id: "agent_system_prompt", text: "You are a reviewer." },
  ];

  await updateRunStatus(run.id, "running", { promptHash, promptSegments: segments });

  await expect(getRunPrompt(run.id)).resolves.toEqual({ runId: run.id, segments, promptHash });
  // Segments must never surface on the Run type — it rides the task page's status polls.
  const fetched = await getRun(run.id);
  expect(fetched).not.toHaveProperty("promptSegments");
});

it("returns undefined from getRunPrompt for a missing run and for a run without stored segments", async () => {
  const session = await setupSession();
  const run = await createRun(session.id);

  await expect(getRunPrompt(run.id)).resolves.toBeUndefined();
  await expect(getRunPrompt(999999)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:db -- messages-runs-events`
Expected: FAIL — `getRunPrompt` is not exported. (Requires the scratch Postgres from `.env.test.local`; see `packages/db/src/__tests__/setup.ts`.)

- [ ] **Step 3: Add the column and generate the migration**

In `packages/db/src/schema.ts`, `runs` table, directly after the `workspaceSnapshot` column:

```ts
// The exact system prompt this run's turn received, as ordered labeled segments
// (PromptSegment in @agentfactory/core; join of texts === the sent string, and
// prompt_hash on this row is the hash of that join). Null until the run composes
// a prompt — and permanently null for runs that fail before that point, which is
// itself diagnostic. Follows the workspaceSnapshot precedent for large per-run
// jsonb; read only via getRunPrompt, never selected into Run.
promptSegments: jsonb("prompt_segments").$type<PromptSegment[]>(),
```

Add `PromptSegment` to the existing `@agentfactory/core` type import at the top of `schema.ts`. Then:

Run: `pnpm --filter @agentfactory/db db:generate`
Expected: a new `packages/db/drizzle/00XX_*.sql` containing `ALTER TABLE "runs" ADD COLUMN "prompt_segments" jsonb;` (plus its `meta/` snapshot).

- [ ] **Step 4: Implement the repository changes**

In `packages/db/src/repositories/runs.ts`:

Add to the `@agentfactory/core` type import: `PromptSegment, RunPrompt`.

Extend `updateRunStatus`'s patch parameter type and body:

```ts
patch?: {
  finishedAt?: Date;
  providerSessionRef?: string;
  model?: ModelSpec;
  promptHash?: string;
  promptSegments?: PromptSegment[];
},
```

and in the body, alongside the existing lines:

```ts
if (patch?.promptSegments !== undefined) values.promptSegments = patch.promptSegments;
```

Append the narrow read:

```ts
// The Context tab's read. Selects ONLY the prompt columns — never the full row —
// so this can't grow into another every-column poll payload the way
// getRun/getRunsForSession ship workspaceSnapshot on every status tick.
export async function getRunPrompt(id: number): Promise<RunPrompt | undefined> {
  const [row] = await db
    .select({ promptSegments: runs.promptSegments, promptHash: runs.promptHash })
    .from(runs)
    .where(eq(runs.id, id));
  if (!row?.promptSegments) return undefined;
  // promptHash stays undefined rather than "" when the column is null — an empty
  // string would be indistinguishable from a real (impossible) empty hash, and
  // this feature exists to stop the stored record lying about what was sent.
  return { runId: id, segments: row.promptSegments, promptHash: row.promptHash ?? undefined };
}
```

Verify `packages/db/src/index.ts` re-exports `repositories/runs` (it exports the existing run functions today; follow the same export style for `getRunPrompt` if exports are named individually).

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test:db -- messages-runs-events` — Expected: PASS (setup runs migrations automatically).
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/repositories/runs.ts packages/db/drizzle packages/db/src/__tests__/repositories/messages-runs-events.test.ts packages/db/src/index.ts
git commit -m "Store run prompt segments in a dedicated column with a narrow read"
```

---

### Task 3: Worker persists the segments

**Files:**
- Modify: `apps/worker/src/worker.ts` (the `updateRunStatus` call adapted in Task 1 Step 5)

**Interfaces:**
- Consumes: `composed` (the `ComposedPrompt` from Task 1 Step 5), `updateRunStatus` with `promptSegments` (Task 2).
- Produces: every run that reaches prompt composition has `prompt_segments` populated atomically with `prompt_hash`.

- [ ] **Step 1: Persist segments in the same statement as the hash**

In `apps/worker/src/worker.ts`, the line from Task 1 Step 5:

```ts
await updateRunStatus(runId, "running", { promptHash: hashPrompt(systemPrompt) });
```

becomes:

```ts
// Segments and hash describe the same string and are computed at the same moment;
// storing them in one statement means they can never describe different prompts.
await updateRunStatus(runId, "running", {
  promptHash: hashPrompt(composed.prompt),
  promptSegments: composed.segments,
});
```

- [ ] **Step 2: Typecheck and run worker tests**

Run: `pnpm typecheck` — Expected: clean.
Run: `pnpm test:unit` — Expected: PASS (no unit test covers `worker.ts`'s run pipeline directly; the segment-building logic it feeds is covered by Task 1's tests, and the write path by Task 2's).

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/worker.ts
git commit -m "Persist run prompt segments alongside the prompt hash"
```

---

### Task 4: `GET /api/runs/[runId]/prompt` route

**Files:**
- Create: `apps/web/src/app/api/runs/[runId]/prompt/route.ts`

**Interfaces:**
- Consumes: `getRunPrompt` from `@agentfactory/db` (Task 2), `requireAuthContext` from `@/server/auth`.
- Produces (Task 5 relies on this contract): `GET /api/runs/:runId/prompt` → 200 with `RunPrompt` JSON when segments exist; 200 with `{ segments: null }` when the run is missing or never composed a prompt (the tab must distinguish "no prompt recorded" from transport errors, so neither case is a 404); 401 when unauthenticated.

- [ ] **Step 1: Implement the route**

Create `apps/web/src/app/api/runs/[runId]/prompt/route.ts` (mirrors the sibling `runs/[runId]/route.ts` shape, including its documented tenant-isolation caveat):

```ts
import { NextResponse } from "next/server";
import { getRunPrompt } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// The Context tab's data source — fetched lazily on tab open, never polled.
// Requires a logged-in user but doesn't yet verify runId belongs to their org — same
// documented tenant-isolation gap as runs/[runId]/route.ts, not new here.
//
// A missing run and a run that failed before composing a prompt both return
// { segments: null } with 200: the tab renders "no prompt recorded" for both, and
// reserves non-2xx for transport/auth failures.
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { runId } = await params;
  const prompt = await getRunPrompt(Number(runId));
  if (!prompt) return NextResponse.json({ segments: null });
  return NextResponse.json(prompt);
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck` — Expected: clean.
Run: `pnpm lint` — Expected: clean. (No route-handler test infra exists in `apps/web`; the repository behavior underneath is covered by Task 2's tests, and the tab exercises the route end-to-end in Task 5's verification.)

- [ ] **Step 3: Commit**

```bash
git add "apps/web/src/app/api/runs/[runId]/prompt/route.ts"
git commit -m "Add run prompt endpoint for the Context tab"
```

---

### Task 5: Context tab on the task page

**Files:**
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` (inside the existing `taskDetail` block, ~line 243)
- Create: `apps/web/src/components/RunContextPanel.tsx`
- Create: `apps/web/src/components/__tests__/RunContextPanel.test.tsx`
- Modify: `apps/web/src/app/(app)/tasks/[taskId]/page.tsx`

**Interfaces:**
- Consumes: `GET /api/runs/:runId/prompt` (Task 4's contract), `PromptSegment`/`RunPrompt` from `@agentfactory/core`, `apiFetch` from `@/lib/api-client`, `useTranslation`, `EmptyState` from `@agentfactory/shared`.
- Produces: `<RunContextPanel runs={sessionRuns} />` — a self-contained client component; the page only supplies the session's run list (newest first, as `/api/sessions/:id/runs` already returns).

- [ ] **Step 1: Add the i18n strings**

In `en.ts`, inside `taskDetail` (after `contextIncluded`):

```ts
contextTab: "Context",
contextRunLabel: "Run",
contextRawToggle: "View raw prompt",
contextLayersToggle: "View layers",
contextPromptHash: "Prompt hash",
contextBytes: "{bytes} bytes · {percent}%",
contextNoPrompt: "No prompt was recorded for this run — it failed before composing one.",
contextLoadError: "Couldn't load this run's prompt. Try again.",
contextNoRuns: "No runs yet",
contextNoRunsSub: "Each run's assembled prompt will appear here once the agent starts working.",
contextOmittedGeneric: "Not included",
contextOmittedNoTeam: "Not included: agent has no team",
contextOmittedEmptySharedContext: "Not included: the team's shared context is empty",
contextOmittedNoCodebase: "Not included: this session has no codebase attached",
contextOmittedRepoMapPending: "Not included: repo map is still being generated",
contextLayerPlatformPreamble: "Platform preamble",
contextLayerEnvironment: "Environment brief",
contextLayerTeamContext: "Team context",
contextLayerRepoMap: "Repo map",
contextLayerAgentSystemPrompt: "Agent system prompt",
contextLayerUnknown: "Additional context",
```

- [ ] **Step 2: Build `RunContextPanel`**

Create `apps/web/src/components/RunContextPanel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PromptSegment, Run, RunPrompt } from "@agentfactory/core";
import { EmptyState } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

// Segment ids are data (stable, defined in prompt-composition.ts) — labels are copy,
// so the mapping lives here in i18n keys. Unknown ids (future layers) fall through
// to a generic label instead of breaking, per the spec's forward-compatibility rule.
const LAYER_LABEL_KEYS: Record<string, TranslationKey> = {
  platform_preamble: "taskDetail.contextLayerPlatformPreamble",
  environment: "taskDetail.contextLayerEnvironment",
  team_context: "taskDetail.contextLayerTeamContext",
  repo_map: "taskDetail.contextLayerRepoMap",
  agent_system_prompt: "taskDetail.contextLayerAgentSystemPrompt",
};

const OMISSION_LABEL_KEYS: Record<string, TranslationKey> = {
  no_team: "taskDetail.contextOmittedNoTeam",
  empty_shared_context: "taskDetail.contextOmittedEmptySharedContext",
  no_codebase: "taskDetail.contextOmittedNoCodebase",
  repo_map_pending: "taskDetail.contextOmittedRepoMapPending",
};

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

type PromptFetchState = { status: "loading" } | { status: "error" } | { status: "loaded"; prompt: RunPrompt | null };

export function RunContextPanel({ runs }: { runs: Run[] }) {
  const { t } = useTranslation();
  // runs arrive newest-first from /api/sessions/:id/runs; default to the newest.
  // Holds ONLY an explicit pick from the run selector. The run actually shown is derived
  // below, never stored — the tab can be opened before the page's run list finishes
  // loading, and a useState initializer would freeze `null` in that window and leave the
  // panel permanently blank for the common single-run case (no selector is rendered for
  // one run, so nothing would ever set it).
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [promptsByRun, setPromptsByRun] = useState<Map<number, PromptFetchState>>(new Map());
  const [showRaw, setShowRaw] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const setPromptState = useCallback((runId: number, state: PromptFetchState) => {
    setPromptsByRun((prev) => new Map(prev).set(runId, state));
  }, []);

  // The run on screen: an explicit pick if there is one, otherwise the newest run — recomputed
  // every render, so it starts working the moment `runs` arrives rather than being frozen at mount.
  const shownRunId = selectedRunId ?? runs[0]?.id ?? null;

  useEffect(() => {
    if (shownRunId === null || promptsByRun.has(shownRunId)) return;
    setPromptState(shownRunId, { status: "loading" });
    apiFetch<RunPrompt | { segments: null }>(`/api/runs/${shownRunId}/prompt`)
      .then((data) =>
        setPromptState(shownRunId, { status: "loaded", prompt: data.segments === null ? null : (data as RunPrompt) }),
      )
      .catch(() => setPromptState(shownRunId, { status: "error" }));
  }, [shownRunId, promptsByRun, setPromptState]);

  const state = shownRunId !== null ? promptsByRun.get(shownRunId) : undefined;
  const prompt = state?.status === "loaded" ? state.prompt : null;

  const totalBytes = useMemo(
    () => (prompt ? prompt.segments.reduce((sum, s) => sum + byteLength(s.text), 0) : 0),
    [prompt],
  );

  if (runs.length === 0) {
    return <EmptyState title={t("taskDetail.contextNoRuns")} subtitle={t("taskDetail.contextNoRunsSub")} />;
  }

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "22px 28px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        {runs.length > 1 && (
          <select
            value={shownRunId ?? undefined}
            onChange={(e) => {
              setSelectedRunId(Number(e.target.value));
              setShowRaw(false);
              setExpandedIds(new Set());
            }}
            aria-label={t("taskDetail.contextRunLabel")}
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-text)",
              fontSize: 13,
              padding: "6px 10px",
            }}
          >
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {`${t("taskDetail.contextRunLabel")} #${run.id} — ${new Date(run.createdAt).toLocaleString()}`}
              </option>
            ))}
          </select>
        )}
        {prompt && (
          <button
            onClick={() => setShowRaw((v) => !v)}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-neutral-400)",
              cursor: "pointer",
              fontSize: 12,
              padding: "6px 10px",
            }}
          >
            {showRaw ? t("taskDetail.contextLayersToggle") : t("taskDetail.contextRawToggle")}
          </button>
        )}
      </div>

      {state?.status === "loading" && (
        <p style={{ fontSize: 13, color: "var(--color-neutral-500)" }}>{t("common.loading")}</p>
      )}
      {state?.status === "error" && (
        <p style={{ fontSize: 13, color: "#e8a44a" }}>{t("taskDetail.contextLoadError")}</p>
      )}
      {state?.status === "loaded" && prompt === null && (
        <p style={{ fontSize: 13, color: "var(--color-neutral-500)" }}>{t("taskDetail.contextNoPrompt")}</p>
      )}

      {prompt && showRaw && (
        <div>
          {prompt.promptHash && (
            <p style={{ fontSize: 12, color: "var(--color-neutral-600)", marginBottom: 8, fontFamily: "monospace" }}>
              {t("taskDetail.contextPromptHash")}: {prompt.promptHash}
            </p>
          )}
          <pre
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-text)",
              fontSize: 12,
              lineHeight: 1.6,
              overflowX: "auto",
              padding: 16,
              whiteSpace: "pre-wrap",
            }}
          >
            {prompt.segments.map((s) => s.text).join("")}
          </pre>
        </div>
      )}

      {prompt && !showRaw && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {prompt.segments.map((segment, index) => (
            <SegmentRow
              key={`${segment.id}-${index}`}
              segment={segment}
              totalBytes={totalBytes}
              expanded={expandedIds.has(`${segment.id}-${index}`)}
              onToggle={() => toggleExpanded(`${segment.id}-${index}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SegmentRow({
  segment,
  totalBytes,
  expanded,
  onToggle,
}: {
  segment: PromptSegment;
  totalBytes: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const bytes = byteLength(segment.text);
  const omitted = segment.text === "";
  const label = t(LAYER_LABEL_KEYS[segment.id] ?? "taskDetail.contextLayerUnknown");
  const omissionLabel = omitted
    ? t((segment.omittedReason && OMISSION_LABEL_KEYS[segment.omittedReason]) ?? "taskDetail.contextOmittedGeneric")
    : null;

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-md)",
        opacity: omitted ? 0.55 : 1,
      }}
    >
      <button
        onClick={omitted ? undefined : onToggle}
        disabled={omitted}
        style={{
          alignItems: "center",
          background: "none",
          border: "none",
          color: "var(--color-text)",
          cursor: omitted ? "default" : "pointer",
          display: "flex",
          fontSize: 13,
          gap: 10,
          padding: "10px 14px",
          textAlign: "left",
          width: "100%",
        }}
      >
        {!omitted && <span style={{ fontSize: 10, color: "var(--color-neutral-500)" }}>{expanded ? "▾" : "▸"}</span>}
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-neutral-500)" }}>
          {omitted
            ? omissionLabel
            : t("taskDetail.contextBytes", {
                bytes: bytes.toLocaleString(),
                percent: totalBytes > 0 ? ((bytes / totalBytes) * 100).toFixed(1) : "0",
              })}
        </span>
      </button>
      {expanded && !omitted && (
        <pre
          style={{
            borderTop: "1px solid var(--color-divider)",
            color: "var(--color-neutral-300)",
            fontSize: 12,
            lineHeight: 1.6,
            margin: 0,
            maxHeight: 420,
            overflow: "auto",
            padding: "12px 14px",
            whiteSpace: "pre-wrap",
          }}
        >
          {segment.text}
        </pre>
      )}
    </div>
  );
}
```

Note: check how `t()` interpolation works in this repo before using `t("taskDetail.contextBytes", { bytes, percent })` — `taskDetail.confirmDeleteTitle` uses `{title}` placeholders, so the pattern exists; match its exact call signature in `@/lib/i18n/context`.

- [ ] **Step 2b: Write component tests**

Create `apps/web/src/components/__tests__/RunContextPanel.test.tsx`, following the existing pattern in `AssigneeSelect.test.tsx` (jsdom pragma, `I18nProvider` wrapper). Mock `apiFetch` so the panel's fetch is deterministic:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { RunContextPanel } from "../RunContextPanel";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const RUNS: Run[] = [{ id: 7, sessionId: 1, status: "done", costUsd: 0, tokensUsed: 0, createdAt: "2026-08-26T10:00:00.000Z" } as Run];

const PROMPT = {
  runId: 7,
  promptHash: "c".repeat(64),
  segments: [
    { id: "platform_preamble", text: "You are an agent.\n" },
    { id: "team_context", text: "", omittedReason: "no_team" },
    { id: "agent_system_prompt", text: "You are a reviewer." },
  ],
};

function renderPanel(runs: Run[] = RUNS) {
  render(
    <I18nProvider>
      <RunContextPanel runs={runs} />
    </I18nProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

describe("RunContextPanel", () => {
  it("renders an empty state when the session has no runs", () => {
    renderPanel([]);
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("fetches the newest run's prompt once and lists each layer with its label", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Platform preamble")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledExactlyOnceWith("/api/runs/7/prompt");
    expect(screen.getByText("Team context")).toBeInTheDocument();
    expect(screen.getByText("Agent system prompt")).toBeInTheDocument();
  });

  // The reason an omitted layer exists at all — "empty" and "why it's empty" are different bugs.
  it("shows the specific omission reason for a layer that contributed nothing", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Not included: agent has no team")).toBeInTheDocument());
  });

  it("expands a layer to reveal its exact text", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("Platform preamble")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Platform preamble"));
    expect(screen.getByText("You are an agent.")).toBeInTheDocument();
  });

  it("shows the joined prompt and hash in the raw view", async () => {
    apiFetchMock.mockResolvedValue(PROMPT);
    renderPanel();

    await waitFor(() => expect(screen.getByText("View raw prompt")).toBeInTheDocument());
    fireEvent.click(screen.getByText("View raw prompt"));
    expect(screen.getByText("You are an agent.\nYou are a reviewer.")).toBeInTheDocument();
    expect(screen.getByText(`Prompt hash: ${"c".repeat(64)}`)).toBeInTheDocument();
  });

  it("states plainly when a run never recorded a prompt", async () => {
    apiFetchMock.mockResolvedValue({ segments: null });
    renderPanel();

    await waitFor(() =>
      expect(
        screen.getByText("No prompt was recorded for this run — it failed before composing one."),
      ).toBeInTheDocument(),
    );
  });

  it("surfaces a load failure instead of rendering an empty prompt", async () => {
    apiFetchMock.mockRejectedValue(new Error("boom"));
    renderPanel();

    await waitFor(() => expect(screen.getByText("Couldn't load this run's prompt. Try again.")).toBeInTheDocument());
  });
});
```

Adjust the `vi.mock` path and the raw-text matcher if the component's actual import specifier or whitespace handling differs — the assertions, not the selectors, are what must hold. If `toHaveBeenCalledExactlyOnceWith` is unavailable in this Vitest version, use `expect(apiFetchMock).toHaveBeenCalledTimes(1)` plus `toHaveBeenCalledWith`.

Run: `pnpm test:unit -- RunContextPanel` — Expected: PASS.

- [ ] **Step 3: Wire the tab into the task page**

In `apps/web/src/app/(app)/tasks/[taskId]/page.tsx`:

1. Import: `import { RunContextPanel } from "@/components/RunContextPanel";`
2. Widen the tab state (~line 60): `useState<"transcript" | "files" | "context">("transcript")`.
3. Keep the session's runs. The loader at ~line 107 already fetches `runs` but only uses them for the workspace snapshot — add state and store them:
   ```ts
   const [sessionRuns, setSessionRuns] = useState<Run[]>([]);
   ```
   and in the loader, after the existing `apiFetch<Run[]>(...)` resolves: `setSessionRuns(runs);`. Also append the finished run in the two poll-completion handlers (~lines 126 and 152) where `apiFetch<Run>(`/api/runs/${id}`)` resolves:
   ```ts
   setSessionRuns((prev) => (prev.some((r) => r.id === run.id) ? prev.map((r) => (r.id === run.id ? run : r)) : [run, ...prev]));
   ```
4. Add the tab button after the Files `TabBtn` (~line 707). Unlike Files it renders whenever a session exists — "nothing recorded" is a finding, per the spec:
   ```tsx
   {session && (
     <TabBtn active={activeTab === "context"} onClick={() => setActiveTab("context")}>
       {t("taskDetail.contextTab")}
     </TabBtn>
   )}
   ```
   (Use the surrounding code's actual variable for "a session exists" — the page derives it near the top; Files gates on `workspace`, this gates on the session.)
5. Add the tab body after the Files block (~line 972's closing):
   ```tsx
   {activeTab === "context" && <RunContextPanel runs={sessionRuns} />}
   ```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck` — Expected: clean (this also validates every new `TranslationKey`).
Run: `pnpm lint` — Expected: clean.

- [ ] **Step 5: Verify in the running app**

Requires the dev stack (see repo README / docker-compose for Postgres + Redis + worker). With `pnpm dev` and the worker running:

1. Open a task that has at least one completed run **created after Task 3 landed**; open the Context tab.
2. Confirm: five layer rows in order; team context and repo map show either text (expand to read it) or a greyed omission reason; byte counts and percentages render; raw toggle shows the joined prompt and the hash.
3. Open a task whose runs predate this feature (or a failed run): confirm the "No prompt was recorded" message.
4. Confirm the Network panel shows `/api/runs/:id/prompt` fired once per selected run — and **not** on transcript polling ticks.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/i18n/dictionaries/en.ts apps/web/src/components/RunContextPanel.tsx apps/web/src/components/__tests__/RunContextPanel.test.tsx "apps/web/src/app/(app)/tasks/[taskId]/page.tsx"
git commit -m "Add Context tab showing each run's assembled prompt by layer"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:db` — all clean.
- [ ] Re-read the spec's "Out of scope" list and confirm nothing crept in: no change to prompt content/ordering (Task 1's byte-identity tests are the proof), no `Run` type change, no workspaceSnapshot fix, no retention logic.
- [ ] Use superpowers:requesting-code-review before merging.
