# Task-level context documents — design spec

**Date:** 2026-09-01
**Status:** approved

## Problem

Document upload exists today only at the team level (`docs/superpowers/specs/2026-08-27-context-retrieval-design.md`): a `TeamContextItem` is chunked, embedded, and retrieved by cosine similarity, gated by `agent.teamId`. A task carries no documents of its own — its only path to context is inherited transitively through `task.assigneeAgentId → agent.teamId` (`packages/core/src/domain.ts:188-209` — `Task` has no `teamId` field at all).

The task creation form already has a placeholder for this: a dashed drop-zone stub reading "Layer 2 context — documents specific to this task (upload coming soon)" (`apps/web/src/app/(app)/tasks/new/page.tsx:216-230`, copy at `en.ts:219`). `docs/PRODUCT-DEFINITION.md:93-131` names this gap explicitly as a three-layer context model:

- **Layer 1** (built): `teams.shared_context` — always-on, always injected in full.
- **Layer 2** (the stub): task-linked documents, human-attached at task creation, *specced* as always-injected-in-full with no retrieval — "the human decides what's relevant, the system doesn't guess."
- **Layer 3** (built, ahead of the doc's own "post-alpha" framing): semantic retrieval — chunking, embedding, similarity floor — but scoped only to team documents.

**This design deliberately departs from the Layer 2 spec.** Rather than build task documents as a separate always-injected layer, task documents are chunked and embedded exactly like team documents, and retrieval draws from both sources, merged into one ranked, budget-capped result per run. Decided explicitly over the specced always-inject-in-full alternative: task documents get the same relevance filtering and budget protection team documents already have, and a task with several substantial documents doesn't unconditionally spend prompt budget on all of them regardless of relevance to the specific run. `PRODUCT-DEFINITION.md` §6 is not updated by this design; it should be revisited separately.

## Goal

A task can have its own uploaded documents — attached at creation (replacing the existing stub) or added later from the task detail page — chunked and embedded on the same pipeline as team documents. Retrieval for a run considers both the task's own documents and its team's, merged into a single ranked, floor-and-budget-capped selection, whether or not the task has a team at all.

## Ground truth this design relies on

- **Tasks have no `teamId` column.** `packages/db/src/schema.ts:306-344`. A task's team is only reachable via `task.assigneeAgentId → agents.teamId`, and a task can have no assignee (`open` status) or an assignee with no team.
- **`worker.ts` only calls `retrieveContext` at all when a team resolves.** `if (team) { retrieved = await retrieveContext(team.id, query); }` (`apps/worker/src/worker.ts:202-208`) — a teamless task gets no retrieval call whatsoever today, and the embedder is never loaded for it.
- **The team pipeline's naming has no "team" in most of it, because it was the only scope.** `ingestContextItem`, `countIndexedContextItems`, `searchContextChunks`, `markContextItemIndexing/Indexed/Failed`, `deleteChunksForItem`, `insertContextChunks` (`apps/worker/src/context-ingest.ts`, `apps/worker/src/context-retrieval.ts`, `packages/db/src/repositories/team-context-items.ts`) all read as generic today; adding a second scope makes that misleading.
- **The ingest queue's `jobId` is `item-${itemId}` off a single Postgres identity sequence** (`packages/queue/src/index.ts:88-93`, `team_context_items.id` — `generatedByDefaultAsIdentity()`). A second items table starts its own identity sequence at 1, so `item-5` for a team document and `item-5` for a task document would collide if enqueued onto the same queue.
- **`run_context_retrievals.itemId` is a hard FK into `team_context_items` only, with `onDelete: "set null"`** (`packages/db/src/schema.ts:447-467`). Nothing joins back through it — `RunContextPanel.tsx:426-431` only checks it for `undefined` (rendering "(source deleted)") and otherwise displays the already-stored `itemTitle` snapshot; `listRunContextRetrievals`/`insertRunContextRetrievals` (`packages/db/src/repositories/run-context-retrievals.ts`) never select through the FK either. So the FK's only live behavior is the automatic null-out on delete, not referential integrity anything reads.
- **`deleteTeamContextItemForOrg` does not itself null out `run_context_retrievals` rows** (`packages/db/src/repositories/team-context-items.ts:70-76`) — that happens purely via the DB's `ON DELETE SET NULL`. Dropping the FK moves that responsibility into application code.
- **`buildRetrievedContextSegment(hasTeam, hasIndexedDocuments, wrapped)`** (`apps/worker/src/prompt-composition.ts:107-118`) treats "no team" and "nothing to search" as the same case, correct today because a team was the only possible source. Its `no_team` omission reason renders as "Not included: agent has no team" (`en.ts:278`) and `no_indexed_documents` renders as "Not included: this **team** has no indexed documents" (`en.ts:282`) — both team-specific copy that becomes wrong once a teamless task can retrieve from its own documents.
- **Chunks already carry document-title provenance in their own text.** The chunker prefixes every chunk with `<document title> › <heading path>` before embedding (per the ingestion mechanism in the 2026-08-27 spec), and `RETRIEVED_CONTEXT` excerpts are numbered `[Excerpt N]` in rank order (`apps/worker/src/context-retrieval.ts:143`) — the model-facing text already distinguishes documents by title without needing a team-vs-task label. Only the `run_context_retrievals` provenance rows (read by the UI, never by the model) need a source tag, for the delete-nulling fix above.
- **The task detail page already has a "Context" tab** (`apps/web/src/app/(app)/tasks/[taskId]/page.tsx:62,719-733,1051`) rendering `RunContextPanel` — per-run retrieval history, not document management.
- **`ContextDocumentsPanel` is already a standalone, reusable component** (`apps/web/src/components/ContextDocumentsPanel.tsx`) taking a `teamId` prop and calling `/api/teams/${teamId}/context-items`; several of its copy strings (`teamsV2.documents*` in `en.ts:428-438`) name "team" explicitly.
- **Team uploads are capped at 2 MB, restricted to `text/markdown` and `text/plain`**, enforced identically client-side (`ContextDocumentsPanel.tsx:19-31`) and server-side (`apps/web/src/app/api/teams/[teamId]/context-items/route.ts:16-33`).
- **`apiFetch` already has a FormData branch** (per the 2026-08-27 spec's Design decisions) — task uploads reuse it as-is, no client changes needed there.

## Scope

- `packages/db/src/schema.ts` — new `taskContextItems`, `taskContextChunks` tables; `runContextRetrievals` gains `itemKind` and drops its `itemId` FK.
- `packages/db/drizzle/` — generated migrations for the above.
- `packages/core/src/domain.ts` — `TaskContextItem` type (mirrors `TeamContextItem`), `RunContextRetrieval.itemKind`, one new `PromptOmissionReason` code (`no_context_sources`).
- `packages/db/src/repositories/` — new `task-context-items.ts`, new `task-context-chunks` functions; renames across `team-context-items.ts` and the team chunks repository for symmetry (see Design decisions); `run-context-retrievals.ts` updated for `itemKind` and the delete-time null-out.
- `packages/queue/src/index.ts` — rename `CONTEXT_INGEST_QUEUE_NAME`/`enqueueContextIngestJob` → `TEAM_...`; add `TASK_CONTEXT_INGEST_QUEUE_NAME`/`enqueueTaskContextIngestJob`.
- `apps/worker/src/context-ingest.ts` — rename `ingestContextItem` → `ingestTeamContextItem`; add `ingestTaskContextItem`.
- `apps/worker/src/context-retrieval.ts` — `retrieveContext` takes a scope `{ teamId?, taskId? }` instead of a single `teamId`; merges and re-ranks across both sources.
- `apps/worker/src/prompt-composition.ts` — `buildRetrievedContextSegment` signature and omission-reason logic.
- `apps/worker/src/worker.ts` — the `if (team)` retrieval gate becomes `if (team || task)`; retrieval scope object built from both.
- `apps/web/src/app/api/tasks/[taskId]/context-items/**` (new) — `GET`/`POST`/`DELETE`, mirroring the team routes.
- `apps/web/src/components/ContextDocumentsPanel.tsx` — generalized to accept a scope prop instead of a hardcoded `teamId`.
- `apps/web/src/components/RunContextPanel.tsx` — new omission reason label; `itemKind`-aware provenance rendering.
- `apps/web/src/app/(app)/tasks/new/page.tsx` — stub replaced with a real staged multi-file picker.
- `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` — Context tab gets `ContextDocumentsPanel` above `RunContextPanel`.
- `apps/web/src/lib/i18n/dictionaries/en.ts` — task-scoped copy for the documents panel; two omission-reason strings reworded to be scope-neutral.

## Out of scope

- **PDF/.docx.** Inherits the team pipeline's existing `TextExtractor` seam and its existing restriction to markdown/plain text.
- **Per-document manual pinning, weighting, or opting a specific document out of retrieval.** Not part of the team design either; not introduced here.
- **Retrieval-quality evaluation for the merged case.** or-borco/AgentFactory#134 and #135 (judge reliability, similarity-floor calibration) are pre-existing open problems for the team-only pipeline; this design does not resolve them, and the merge doubles the surface they apply to without new measurement.
- **Reconciling `PRODUCT-DEFINITION.md`'s Layer 2 description with this design.** Flagged as a deliberate deviation above; updating that doc is a separate, smaller follow-up.
- **Blob garbage collection.** Already out of scope for the team pipeline; unchanged here. Task and team items can reference the same content-addressed blob (same `(org_id, sha256)` key) with no new sharing concern introduced.
- **Cross-task document sharing or a document library independent of both scopes.** A document belongs to exactly one team item or one task item; re-uploading the same file to both is a separate item row pointing at the same blob.

## Design decisions

- **Parallel tables (`task_context_items` / `task_context_chunks`), not a unified `context_items` schema.** A unified table (nullable `team_id` XOR `task_id`) would avoid the id-collision problem below by construction, but it means renaming a shipped, tested feature — repository function names, the `/api/teams/[teamId]/context-items` route shape, `teamsV2.documents*` i18n keys, existing tests — for a change with no other motivating reason right now. Parallel tables keep every line of the shipped team feature untouched.
- **`run_context_retrievals.itemId` loses its DB-level FK; a new `itemKind: "team" | "task"` column disambiguates instead.** A single integer column cannot conditionally FK into two different tables, and team-item ids and task-item ids will collide (both are independent identity sequences starting at 1). Per the ground truth above, nothing reads through this FK today — only its automatic `ON DELETE SET NULL` is load-bearing, and that behavior moves into application code: both `deleteTeamContextItemForOrg` and the new `deleteTaskContextItemForOrg` now explicitly `UPDATE run_context_retrievals SET item_id = NULL WHERE item_id = ? AND item_kind = ?` as part of the delete. Existing rows get `item_kind = 'team'` by default (accurate — every row predates task documents).
- **Two separate BullMQ queues, not one queue with a `kind` field.** A shared queue would need a `kind` in the job payload and a dispatch branch in the processor, and the existing `jobId: item-${itemId}` scheme would collide across the two id spaces (needing a prefixed job id as a workaround). Two independently-namespaced queues (`TEAM_CONTEXT_INGEST_QUEUE_NAME`, `TASK_CONTEXT_INGEST_QUEUE_NAME`) sidestep the collision for free — BullMQ job ids only need to be unique within a queue — and keep the two ingest flows structurally separate end to end, matching the parallel-tables choice above.
- **The team-scoped functions get an explicit "Team" in their names.** `ingestContextItem`, `countIndexedContextItems`, `searchContextChunks`, `markContextItemIndexing/Indexed/Failed`, `deleteChunksForItem`, `insertContextChunks` were generic only because there was one scope; each is renamed with a `Team` prefix, paired with a `Task`-prefixed twin of identical shape. `getTeamContextItem`, `createTeamContextItem`, `listTeamContextItemsForOrg`, `deleteTeamContextItemForOrg` already carry "Team" and are untouched.
- **Retrieval merges both sources into one ranked list with a single shared floor and budget, not two separate prompt segments.** Each source is still queried independently for its own top `RETRIEVAL_K` (12) candidates — so a small, highly-relevant task document is never crowded out at the database query level before merging — but the two result sets are concatenated, sorted by score, and then `SIMILARITY_FLOOR` (0.6) and the 8 KB `RETRIEVAL_BUDGET_BYTES` apply once, over the merged set, unchanged from the team-only pipeline. This means a task's own document can lose the final budget cut to a stronger-matching team excerpt — accepted as correct: "best excerpts win regardless of source" was the explicit goal, not "task documents are guaranteed inclusion."
- **`worker.ts`'s retrieval gate changes from `if (team)` to `if (team || task)`.** Without this, a teamless task's own uploaded documents would be ingested successfully but never actually retrieved for any run — a silent dead end. The pre-flight indexed-count checks (`countIndexedTeamContextItems`/`countIndexedTaskContextItems`, run in parallel, each skipped when its scope id is absent) still guard the embedder from loading when neither scope has anything indexed.
- **One new `PromptOmissionReason`, `no_context_sources`, replaces `no_team` as the retrieved-context segment's "nothing to search" reason; `no_team` itself is untouched everywhere else.** `no_team` stays exactly as-is for the `team_context` (shared_context, Layer 1) segment, where "agent has no team" remains completely accurate. For `retrieved_context`, `buildRetrievedContextSegment`'s first parameter becomes `hasSource = Boolean(team) || Boolean(task)`; when false, the new code fires instead of overloading `no_team` with a now-inaccurate meaning. Additive to the enum, which the type's own comment already documents as non-breaking (`packages/core/src/domain.ts:269-279`) — an older client renders an unrecognized reason with `RunContextPanel`'s existing generic fallback. `no_indexed_documents`'s copy is reworded from "this team has no indexed documents" to the scope-neutral "no indexed documents," since it can now mean either scope, or both, have nothing indexed yet.
- **Task documents are staged client-side and uploaded only after the task itself is created.** The upload UI lives on the task creation form, but a task-scoped upload route needs a real `taskId`, which doesn't exist until the form submits. Files are held as an in-memory `File[]` in the creation form's state; on submit, `createTask()` runs first as it does today, and each staged file is then POSTed sequentially to the new task-scoped route using the returned `task.id`. If a staged file's upload fails, the task itself was already created successfully — navigation to the task page proceeds regardless, with a notice naming the failed file(s), since the document panel on the task detail page (see below) is exactly where a retry belongs.
- **Task documents are also manageable after task creation**, via a `ContextDocumentsPanel` placed above the existing per-run `RunContextPanel` in the task detail page's Context tab — not upload-once-at-creation-only. Tasks routinely need new context after they're already in progress (e.g. after moving to `needs_input`), and the team pattern already supports ongoing add/delete.
- **`ContextDocumentsPanel` is generalized to a scope prop** (`{ kind: "team", teamId }` or `{ kind: "task", taskId }`) rather than duplicated, since its only scope-specific surface is which API routes it calls and a handful of copy strings that name "team" explicitly — those get parallel task-scoped i18n keys selected by the same prop.
- **Task uploads reuse the team pipeline's limits exactly: 2 MB, `text/markdown` / `text/plain` only.** No product reason surfaced for task documents to differ, and identical constants keep the client-side and server-side checks (already duplicated once, by design, per the team route's own comments) easy to keep in sync across both scopes.

## Mechanism

### Schema

```ts
// New — mirrors team_context_items exactly, keyed by taskId instead of teamId.
export const taskContextItems = pgTable(
  "task_context_items",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    taskId: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    orgId: integer("org_id").notNull().references(() => orgs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    source: text("source").notNull().default("upload"),
    status: contextItemStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.sha256],
      foreignColumns: [contentBlobs.orgId, contentBlobs.sha256],
    }),
    uniqueIndex("task_context_items_task_sha").on(t.taskId, t.sha256),
  ],
);

// New — mirrors context_chunks exactly, keyed by taskId instead of teamId.
export const taskContextChunks = pgTable(
  "task_context_chunks",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    itemId: integer("item_id").notNull().references(() => taskContextItems.id, { onDelete: "cascade" }),
    taskId: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    chunkIdx: integer("chunk_idx").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 384 }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("task_context_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("task_context_chunks_task_id_idx").on(t.taskId),
  ],
);

// Changed — run_context_retrievals gains item_kind, drops the itemId FK.
export const contextItemKindEnum = pgEnum("context_item_kind", ["team", "task"]);

export const runContextRetrievals = pgTable(
  "run_context_retrievals",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    runId: integer("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    // No .references() — see Design decisions: itemId can point at either
    // team_context_items or task_context_items, and the two id spaces collide.
    // Nulled explicitly by both deleteTeamContextItemForOrg and
    // deleteTaskContextItemForOrg, replacing the FK's old ON DELETE SET NULL.
    itemId: integer("item_id"),
    itemKind: contextItemKindEnum("item_kind").notNull().default("team"),
    itemTitle: text("item_title").notNull(),
    chunkIdx: integer("chunk_idx").notNull(),
    rank: integer("rank").notNull(),
    score: doublePrecision("score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("run_context_retrievals_run_id_idx").on(t.runId)],
);
```

`TaskContextItem` in `packages/core/src/domain.ts` is `TeamContextItem` with `taskId` in place of `teamId`. `RunContextRetrieval` gains `itemKind: "team" | "task"`.

### Ingestion (task side)

```
POST /api/tasks/[taskId]/context-items   (multipart/form-data: file, title?)
  → requireAuthContext, assert the task belongs to the caller's org
  → same Content-Length gate, same 2 MB cap, same { text/markdown, text/plain } check
    as the team route
  → bytes = await file.arrayBuffer(); re-check size
  → BlobStore.put(orgId, …) → insert content_blobs on conflict (org_id, sha256) do nothing
  → insert task_context_items { orgId, taskId, status: 'pending', sha256, mime, uploadedBy }
    409 on (task, sha) conflict
  → enqueueTaskContextIngestJob(itemId)
  → 201 with the item
```

`ingestTaskContextItem` is `ingestTeamContextItem`'s exact shape — status guard (`pending | indexing` admitted, everything else refused as a stalled-redelivery no-op), `markIndexing → extractText → chunkDocument → deleteTaskChunksForItem → embed in batches of 32 → insertTaskContextChunks → markIndexed | markFailed` — reading/writing `task_context_items`/`task_context_chunks` instead. Same `TaskIngestDeps`-shaped dependency injection as the team version, for the same testability reasons.

### Retrieval

```
retrieveContext({ teamId, taskId }, query):
  if !query.trim(): return OMITTED("no_relevant_chunks")
  [teamCount, taskCount] = Promise.all([
    teamId ? countIndexedTeamContextItems(teamId) : 0,
    taskId ? countIndexedTaskContextItems(taskId) : 0,
  ])
  if teamCount + taskCount === 0: return OMITTED("no_indexed_documents")

  embedding = embedder.embedQuery(query)
  [teamMatches, taskMatches] = Promise.all([
    teamId ? searchTeamContextChunks(teamId, embedding, RETRIEVAL_K) : [],
    taskId ? searchTaskContextChunks(taskId, embedding, RETRIEVAL_K) : [],
  ])
  merged  = [...teamMatches.map(tag("team")), ...taskMatches.map(tag("task"))]
              .sort((a, b) => b.score - a.score)
  relevant = merged.filter(m => m.score >= SIMILARITY_FLOOR)
  kept     = selectWithinBudget(relevant, RETRIEVAL_BUDGET_BYTES)   // unchanged
  if kept.length === 0: return OMITTED("no_relevant_chunks")
  → same RETRIEVED_CONTEXT_HEADING/FOOTER wrapping, [Excerpt N] numbering, unchanged
  → retrievals: kept.map(m => ({ itemId: m.itemId, itemKind: m.itemKind, itemTitle: m.itemTitle, ... }))
```

`worker.ts`'s call site changes from `if (team) { retrieved = await retrieveContext(team.id, query) }` to `if (team || task) { retrieved = await retrieveContext({ teamId: team?.id, taskId: task?.id }, query) }`.

### Prompt composition

Ordering is unchanged — `platform_preamble → environment → repo_map → retrieved_context → team_context → agent_system_prompt` — since the merge happens *inside* `retrieved_context`, not as a new segment. `buildRetrievedContextSegment(hasSource, hasIndexedDocuments, wrapped)` where `hasSource = Boolean(team) || Boolean(task)`, returning `no_context_sources` when false (new), `no_indexed_documents` (reworded copy) when true-but-empty, `no_relevant_chunks` otherwise — matching the existing three-state shape with one relabeled input.

### UI

**Task creation** (`tasks/new/page.tsx`) — the dashed stub becomes a real multi-file input. Selected files are held in local state (`File[]`, no network call yet); on submit, `createTask()` runs, then each staged file is POSTed to `/api/tasks/${task.id}/context-items` in sequence before navigating to the task page. A failed individual upload doesn't block navigation — it surfaces as a named notice, retryable from the task detail page.

**Task detail** (`tasks/[taskId]/page.tsx`) — Context tab renders `<ContextDocumentsPanel scope={{ kind: "task", taskId: task.id }} members={orgMembers} />` above the existing `<RunContextPanel runs={sessionRuns} />`.

**`ContextDocumentsPanel`** — `teamId` prop replaced by a `scope` union; internally selects the route base (`/api/teams/${teamId}` vs `/api/tasks/${taskId}`) and the i18n key set (new `taskDetail.documents*` keys paralleling `teamsV2.documents*`) off it. Upload/list/delete logic, polling-while-pending behavior, and status badges are otherwise identical.

**`RunContextPanel`** — provenance rows already display `itemTitle` per retrieval; each now also carries `itemKind`, usable for a small "(team)"/"(task)" tag next to the title if desired, and required internally so the "(source deleted)" check still works correctly once `itemId` is no longer an enforced FK (`undefined` still means deleted; `itemKind` disambiguates which delete path nulled it, for the rare case a team and task item happened to share a numeric id).

## Testing

- **Unit.** `retrieveContext`'s merge: team-only, task-only, both non-empty (assert ranking is by score across sources, not source-then-score), neither indexed (`no_indexed_documents`), neither existing (`no_context_sources`), a task doc that would qualify alone but loses the final budget cut to stronger team matches. `buildRetrievedContextSegment`'s four states. `ingestTaskContextItem`: same status-guard and idempotent-redelivery cases already covered for `ingestTeamContextItem`, with `TaskIngestDeps` stubs.
- **DB integration.** `task_context_items`/`task_context_chunks` repository lifecycles and org/task scoping, mirroring the existing team suite. Delete-nulling: a `run_context_retrievals` row with `itemKind: 'task'` is nulled by `deleteTaskContextItemForOrg` and untouched by `deleteTeamContextItemForOrg` on an unrelated team item, and vice versa. Cross-scope id collision: a team item and a task item sharing the same numeric `id` (forced via explicit ids in a test fixture) each retrieve and delete correctly without cross-contamination.
- **Component.** `ContextDocumentsPanel` with `scope: "task"` in each status state. `RunContextPanel` rendering a merged retrieval (team + task rows in one run) and the new omission reason.
- **E2E.** Task creation with a staged file: task appears, document appears at `pending`. Task detail page: add a document after creation, delete it, confirm it disappears from the panel. Anything requiring `indexed` or an actual merged-retrieval run belongs to the unit/db-integration layers, matching the existing convention for the team pipeline (`run-eval.spec.ts` runs no worker).

## PR sequence

| # | PR | Contents | Demoable |
|---|---|---|---|
| 1 | **Symmetry rename (no behavior change)** | `ingestContextItem` → `ingestTeamContextItem`, `countIndexedContextItems` → `countIndexedTeamContextItems`, `searchContextChunks` → `searchTeamContextChunks`, `markContextItem*` → `markTeamContextItem*`, `deleteChunksForItem` → `deleteTeamChunksForItem`, `insertContextChunks` → `insertTeamContextChunks`, `CONTEXT_INGEST_QUEUE_NAME`/`enqueueContextIngestJob` → `TEAM_...` | No |
| 2 | **Task document schema** | `task_context_items`, `task_context_chunks` tables + migration, `TaskContextItem` in core, repository functions (`getTaskContextItem`, `createTaskContextItem`, `listTaskContextItemsForOrg`, `deleteTaskContextItemForOrg`, `countIndexedTaskContextItems`, `searchTaskContextChunks`, `markTaskContextItem*`, `insertTaskContextChunks`, `deleteTaskChunksForItem`) | No — unwired |
| 3 | **Task upload routes** | `GET`/`POST`/`DELETE /api/tasks/[taskId]/context-items`, reusing the existing `BlobStore` and `apiFetch` FormData branch as-is | Yes — files persist at `pending`, no ingestion yet |
| 4 | **Task ingestion worker** | `TASK_CONTEXT_INGEST_QUEUE_NAME`/`enqueueTaskContextIngestJob`, `ingestTaskContextItem`, queue processor registration | Yes — status reaches `indexed` |
| 5 | **`run_context_retrievals.itemKind` + FK drop** | Migration, `itemKind` on `RunContextRetrieval`, delete-time null-out added to both `deleteTeamContextItemForOrg` and `deleteTaskContextItemForOrg` | No — no reader yet |
| 6 | **Merged retrieval + worker gate fix** | `retrieveContext({ teamId, taskId }, query)`, `worker.ts`'s `if (team) → if (team \|\| task)`, `no_context_sources` omission reason, reworded `no_indexed_documents` copy | Yes — task-only and merged retrieval both work |
| 7 | **UI** | Task creation form's staged multi-file upload (replacing the stub), `ContextDocumentsPanel` scope prop + task-scoped i18n, task detail page's Context tab panel, `RunContextPanel` `itemKind` awareness | Yes — end to end |

PR 1 and PR 2 carry no product behavior, kept small for fast review per the size guideline. PR 6 is where the feature functionally exists; PR 7 is where a person can use it.

## Risks

- **The merged ranking can starve a task's own document if the team corpus is large and topically close.** Accepted per the explicit "best excerpts win regardless of source" decision above — not a defect, but worth stating as the tradeoff against the rejected always-inject-in-full alternative.
- **Dropping the `run_context_retrievals.itemId` FK trades DB-enforced integrity for application-level correctness.** Both delete paths must remember to null matching rows; the db-integration cross-scope test above is the regression guard, but a future third scope (if one is ever added) would need the same discipline applied a third time.
- **This design's departure from `PRODUCT-DEFINITION.md`'s Layer 2 spec leaves that document inaccurate until it's separately updated.** Flagged in Problem and Out of scope; not fixed here.
- **Retrieval-quality measurement debt (#134, #135) now applies to a two-source merge instead of one source, without new evidence gathered here.**
