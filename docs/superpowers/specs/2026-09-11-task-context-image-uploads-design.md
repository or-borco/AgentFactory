# Task-scoped image uploads for context items — design spec

**Date:** 2026-09-11
**Status:** proposed

## Problem

Task-level context items (`docs/superpowers/specs/2026-09-01-task-level-context-documents-design.md`) let a human attach documents to a task; they're chunked, embedded, and either retrieved by similarity or (per that design's split-budget mechanism) always surfaced to the run. Uploads are restricted to `text/markdown`/`text/plain` (`apps/web/src/app/api/tasks/[taskId]/context-items/route.ts:20`, mirrored client-side at `apps/web/src/components/ContextDocumentsPanel.tsx:55`), and every uploaded document is also fully materialized as a real file into the run's sandbox before the agent starts (`apps/worker/src/task-documents.ts:76-131`), independent of retrieval — so the agent can read the whole of what a human attached.

Users doing task work often have a screenshot, mockup, or diagram that's directly relevant to what the agent should build or fix — a UI mockup to implement, a screenshot of a bug, a design reference. There's currently no way to attach one: the upload route rejects any image MIME type, and even if it didn't, `text-extract.ts`'s `extractText` would throw `UnsupportedMimeError` on it during ingestion (`apps/worker/src/text-extract.ts:4,13-17`), and `task-documents.ts:114`'s `TextDecoder().decode(bytes)` would corrupt binary bytes if it ever received them.

## Goal

A task's context-items uploader accepts `.jpg`/`.jpeg`/`.png` in addition to `.md`/`.txt`. An uploaded image is stored and shown in the task's context-items list (with a thumbnail), but is not chunked/embedded — there's no text to extract, and per product decision this feature does not include OCR or vision captioning. Because task documents are always materialized into the sandbox regardless of retrieval, an indexed image is copied into the sandbox alongside text documents before a run starts, and the environment description that's injected into the agent's prompt tells it these are images to view. Team-level context items are unaffected — this design is task-scoped only.

## Ground truth this design relies on

- **The upload route is the sole enforcement point for allowed file types.** `apps/web/src/app/api/tasks/[taskId]/context-items/route.ts:18-27` (`MAX_UPLOAD_BYTES = 2 * 1024 * 1024`, `ALLOWED_MIMES = new Set(["text/markdown", "text/plain"])`, extension fallback for `.md`/`.markdown`/`.txt`). `ContextDocumentsPanel.tsx:54-66` mirrors the same values client-side purely for named error copy — per its own comment, "the route is the enforcement point."
- **The teams route is untouched by this design.** `apps/web/src/app/api/teams/[teamId]/context-items/route.ts` keeps exactly today's `{ text/markdown, text/plain }` whitelist; team-level image support is explicitly out of scope.
- **`ContextDocumentsPanel` is shared by both scopes via a `scope` prop** (`{ kind: "team", teamId }` | `{ kind: "task", taskId }`, `ContextDocumentsPanel.tsx:19`). Its allowed-MIME list, extension fallback, and `accept` attribute are currently scope-independent constants — this design makes them scope-conditional for the first time.
- **No route currently serves a context item's raw bytes.** `apps/web/src/app/api/tasks/[taskId]/context-items/[itemId]/route.ts` implements only `DELETE` (line 5). A browser `<img>` thumbnail needs a URL that returns image bytes with the right `Content-Type`.
- **`getTaskContextItem(id: number): Promise<TaskContextItem | undefined>`** (`packages/db/src/repositories/task-context-items.ts:64`) takes no `orgId` — unlike `deleteTaskContextItemForOrg`, callers must check `item.orgId === ctx.orgId` themselves.
- **`BlobStore.get(orgId: number, sha256: string): Promise<Uint8Array | undefined>`** (`packages/storage/src/blob-store.ts:14`) is mime-agnostic — the stored `mime` column, not the blob store, is what a reader needs to set `Content-Type`.
- **`ingestTaskContextItem`** (`apps/worker/src/context-ingest.ts`, mirrors `ingestTeamContextItem`'s shape at lines ~170-213) transitions `pending → indexing` (`markTaskContextItemIndexing`) then calls `extractText(item.mime, bytes)` (line 184) before chunking/embedding, finishing at `markTaskContextItemIndexed` or, on any thrown error, `markTaskContextItemFailed`. `extractText` throws `UnsupportedMimeError` for any mime outside `SUPPORTED_MIMES` (`text-extract.ts:13-17`) — today, an image that reached this function would land the item as `failed`.
- **`materialiseTaskDocuments`** (`apps/worker/src/task-documents.ts:76-131`) only ever runs against `indexed` items (line 88), reads each blob via `blobStore.get(orgId, item.sha256)` (line 104), decodes it as UTF-8 text (line 114, "uploads are constrained to text/markdown and text/plain... decoding as UTF-8 is safe here and writeFiles takes strings"), and writes into a `Record<string, string>` passed to `sandboxProvider.writeFiles`. `TASK_DOCUMENTS_BUDGET_BYTES = 1024 * 1024` (line 13) caps the total bytes materialized per run, independent of the 2 MB per-file upload cap — a single legitimately-uploaded 1.5 MB image would already exceed this budget on its own.
- **`SandboxProvider.writeFiles(id: string, files: Record<string, string>): Promise<void>`** (`apps/worker/src/sandbox/types.ts:28`) is typed as UTF-8-string-only. The concrete implementation (`apps/worker/src/sandbox/docker-sandbox-provider.ts:222-230`) builds a `tar-stream` archive and calls `tar.entry({ name: path }, contents)` per file — `tar-stream`'s `entry()` writes whatever bytes it's given verbatim and accepts a `Buffer` exactly as well as a `string`, so binary content can be written safely once the type signature admits it.
- **`materialiseTaskDocuments` is called once, from `worker.ts:155`**, right after cloning the repo into the sandbox, and its `written`/`omitted` result is passed into a `SandboxEnvironment` (`prompt-composition.ts:28`) that `formatEnvironmentForPrompt` (lines 39-100) turns into prose: `written` paths are described as the complete files to read directly (lines 80-99); `omitted` titles get a separate sentence noting they're attached but didn't make it into the sandbox.
- **`TASK_DOCUMENT_DIR = ".agentfactory/context"`** and **`TASK_DOCUMENT_EXCLUDE_PATTERN = "/.agentfactory/"`** (`apps/worker/src/task-document-paths.ts:9,13`); the exclude pattern is appended to `/workspace/.git/info/exclude` (`apps/worker/src/scm-provider.ts:235-239`) so materialized files stay untracked without touching the repo's own `.gitignore`. The pattern excludes the whole directory by path, not by filename or extension (confirmed by reading `cloneIntoSandbox`'s exclusion script directly) — since this design writes images into the same `TASK_DOCUMENT_DIR` as text documents, they are excluded automatically. **No change needed here for images to be git-ignored.**
- **`sanitiseDocumentName`** (`task-documents.ts:46-54`) already allowlists `[A-Za-z0-9._-]` and preserves the file extension, so it works unchanged for `.jpg`/`.png` filenames.
- **`packages/core` already exports runtime constants, not just types, consumed by client components.** `MODEL_CATALOG`, `DEFAULT_MODEL_ID`, and functions like `nextEscalationTier`/`isValidModelId` (`packages/core/src/models.ts:11-40`) are plain runtime values re-exported from `packages/core/src/index.ts` and imported directly by client-rendered pages (e.g. `apps/web/src/app/(app)/tasks/new/page.tsx`). This is the existing precedent for putting a small shared, non-type table in `packages/core` when both `apps/web` and `apps/worker` need to agree on it — CLAUDE.md already states `packages/core` is "the single source of truth for all entity shapes; both the web app and the future worker import from here. Never duplicate these types elsewhere," and this project already extends that beyond entity *shapes* to small policy tables like `MODEL_CATALOG`.
- **`extractText(mime, bytes)`** (`apps/worker/src/text-extract.ts`) is itself a mime-keyed dispatch function, not a class hierarchy — the codebase's existing idiom for "different behavior per mime" is a lookup/switch over a plain function, not a Strategy-pattern object graph.

## Scope

- `packages/core/src/context-item-mime.ts` (new) — `TASK_CONTEXT_MIME_CONFIG`, the shared per-mime capability table, plus small derived helpers (`isTaskContextMimeAllowed`, `taskContextExtensionMime`) so consumers don't each re-derive the same lookup logic. Re-exported from `packages/core/src/index.ts`.
- `apps/web/src/app/api/tasks/[taskId]/context-items/route.ts` — `ALLOWED_MIMES`/`extensionMime` replaced by calls into the shared table.
- `apps/web/src/app/api/tasks/[taskId]/context-items/[itemId]/route.ts` — new `GET` handler streaming the item's raw bytes.
- `apps/web/src/components/ContextDocumentsPanel.tsx` — allowed-MIME list, extension fallback, and `accept` attribute become conditional on `scope.kind === "task"`, sourced from the shared table for the task branch; image rows render a thumbnail.
- `apps/worker/src/context-ingest.ts` — `ingestTaskContextItem` gains a branch, keyed off `TASK_CONTEXT_MIME_CONFIG[item.mime].requiresIndexing`, that marks a non-indexing item `indexed` directly, skipping `extractText`/chunk/embed. `ingestTeamContextItem` is untouched.
- `apps/worker/src/task-documents.ts` — writes raw bytes when `TASK_CONTEXT_MIME_CONFIG[item.mime].decodeAsText` is false instead of always UTF-8-decoding; `TASK_DOCUMENTS_BUDGET_BYTES` raised from 1 MB to 8 MB.
- `apps/worker/src/sandbox/types.ts` and `apps/worker/src/sandbox/docker-sandbox-provider.ts` — `writeFiles` widened to accept `Buffer` per file alongside `string`.
- `apps/worker/src/prompt-composition.ts` — environment description text generalized so it reads correctly for both text documents and images.
- `apps/web/src/lib/i18n/dictionaries/en.ts` — updated copy for the task-scoped unsupported-type error (now names images as accepted) and any new UI strings the thumbnail needs.

## Out of scope

- **Team-level image uploads.** The teams route, its ingest path, and `ContextDocumentsPanel`'s team-scope branch keep today's text-only behavior exactly. An image can never reach `ingestTeamContextItem` because the teams upload route never accepts one.
- **OCR, vision captioning, or any text-searchable representation of an image's content.** Per product decision, images are stored and viewed, not indexed for retrieval. `retrieveContext`/`context-retrieval.ts` is untouched.
- **Vision content-blocks in the initial agent prompt.** Images reach the agent as files on disk in the sandbox, exactly like text documents today — not as inline image blocks in the message sent to the model.
- **File types other than JPEG/PNG** (e.g. GIF, WebP, SVG, PDF). Follows the existing pattern of a narrow, explicit whitelist rather than a broad "any image" or "any file" acceptance.
- **A general-purpose blob download/viewer route for team-scoped items.** The new `GET .../context-items/[itemId]/content` route is added under the tasks path only, since only task items can be images and need a byte-serving endpoint. Nothing currently needs the equivalent for team items.
- **Retrying or backfilling existing `failed` items.** Not relevant here — no image could have reached `failed` status before this feature ships, since the upload route already rejects images upstream.

## Design decisions

- **Task-only, enforced entirely at the upload route.** Rather than adding an `imageSupport` flag threaded through several layers, the teams and tasks routes simply keep independent `ALLOWED_MIMES` sets (as they already are — see the 2026-09-01 design's "parallel tables, not a unified schema" precedent). Nothing downstream needs to ask "is this a task item or a team item" — `ingestTeamContextItem` and the team route are simply never touched, so an image can't reach them at all.
- **One shared per-mime capability table (`TASK_CONTEXT_MIME_CONFIG`), not independently-reasoned checks scattered across files.** An earlier version of this design had `ingestTaskContextItem` check `item.mime.startsWith("image/")` and `materialiseTaskDocuments` check membership in a separately-declared `TEXT_MIMES` set — two conditions that happened to be exact inverses of each other for today's four mimes, justified only by a comment explaining why they must be kept in sync by hand. That's exactly the kind of scattered, implicit relationship a single source of truth removes. `TASK_CONTEXT_MIME_CONFIG` (see Mechanism) records, per mime, `extensions: string[]`, `requiresIndexing: boolean`, and `decodeAsText: boolean` — both axes live in one place, and every consumer (the upload route's whitelist/extension-fallback, `ingestTaskContextItem`'s skip-to-`indexed` branch, `materialiseTaskDocuments`'s decode-vs-raw branch, and `ContextDocumentsPanel`'s task-scope `accept` attribute) reads its answer from the same table instead of re-deriving or hand-duplicating it.
- **A plain data table, not a GoF Strategy pattern (interface + one class per mime + runtime dispatch through polymorphism).** The two axes that vary per mime are booleans, not algorithms — every text mime shares identical decode logic, every non-text mime shares identical raw-byte logic. There is no varying *behavior* to swap in, only varying *data*, so a `Record<mime, config>` expresses the same "one source of truth per type" goal a Strategy object graph would, without introducing a class-based idiom this codebase doesn't otherwise use (it's plain functions and data throughout — `extractText`'s existing mime-keyed dispatch, per Ground truth, is the closer existing precedent). If a future format needs a genuinely distinct *algorithm* rather than a different boolean (e.g. PDF getting its own text-extraction implementation), that already has a natural home: a new branch inside `extractText`, exactly as markdown and plain-text extraction presumably already are.
- **The table lives in `packages/core`, not in `apps/worker` alone.** Both `apps/web` (upload route validation, client `accept` attribute) and `apps/worker` (ingest, materialization) need to agree on which mimes are accepted and how each behaves; per Ground truth, `packages/core` already plays exactly this role for `MODEL_CATALOG`, consumed by both a client component and (presumably) worker-side model resolution.
- **The teams route deliberately does not adopt this table.** Team context items have no `requiresIndexing`/`decodeAsText` distinction to make — every team upload is still text, full stop — so migrating the teams route onto `TASK_CONTEXT_MIME_CONFIG` would only recreate the coupling this design is trying to avoid elsewhere: a shared config table that both scopes read would make it easy for a later change to one scope's accepted mimes to silently change the other's. The teams route keeps its own literal `{ text/markdown, text/plain }` set, unchanged, exactly as it does today.
- **Images are marked `indexed` immediately, without inserting any chunks.** `ContextItemStatus` (`pending | indexing | indexed | failed`) is reused as-is — no new status. An `indexed` image item has zero rows in `task_context_chunks`, which is already a valid (if previously theoretical) state: `countIndexedTaskContextItems` and `searchTaskContextChunks` naturally return nothing for it, so `retrieveContext` behaves as if the image doesn't exist for retrieval purposes, which is exactly the intent. `materialiseTaskDocuments` only filters on `status === "indexed"` (not on chunk existence), so this is sufficient to make the image eligible for sandbox materialization.
- **`writeFiles` is widened to `Record<string, string | Buffer>`, not switched entirely to binary.** Every existing text-document call site continues to pass strings unchanged; only the new image branch in `task-documents.ts` passes a `Buffer`. `tar-stream`'s `entry()` already accepts either at runtime (see Ground truth) — this is a type-level widening plus one new branch, not a rewrite of the sandbox-write path.
- **`TASK_DOCUMENTS_BUDGET_BYTES` raised from 1 MB to 8 MB, not left as-is.** At 1 MB, a single 1.5 MB image (well under the 2 MB per-file upload cap) would upload successfully, ingest to `indexed`, and then still get silently `omitted` from the sandbox purely because of a budget that predates images entirely and was sized for a 6.7 KB motivating text document (per the original comment at `task-documents.ts:9-13`). 8 MB comfortably fits several images plus text documents in one run without materially changing the tar payload size relative to what a sandbox provisioning step already handles for repo contents.
- **No separate "images" list in `MaterialisedTaskDocuments` — `written`/`omitted` stay as they are.** The prompt-composition wording is generalized instead (e.g. "open these files directly" rather than "read these files," since Claude Code's own file-reading tool already handles both text and image files transparently). Introducing a parallel `images: string[]` field would duplicate the omission/budget bookkeeping that `written`/`omitted` already does correctly for any file type.
- **The new content-serving route is generic, not image-specific.** `GET /api/tasks/[taskId]/context-items/[itemId]/content` streams whatever bytes and mime the item has — it doesn't special-case images internally. Only the UI's choice to render an `<img src>` for image rows (and not for doc rows) makes it "the image route" in practice; this keeps the route reusable if a future feature wants to serve/download a text document's raw bytes too.
- **The content route checks `item.orgId === ctx.orgId` manually and 404s on mismatch**, following the same "404, not 403" reasoning already used by the sibling `GET` list route (`context-items/route.ts:40-43`) — a task/item in another org must not be distinguishable from one that doesn't exist. `getTaskContextItem` doesn't take an `orgId` (unlike `deleteTaskContextItemForOrg`), so this check has to happen in the route itself.

## Mechanism

### Shared mime capability table (new)

```ts
// packages/core/src/context-item-mime.ts
export interface TaskContextMimeConfig {
  extensions: string[];
  requiresIndexing: boolean;  // false → ingestTaskContextItem skips straight to `indexed`
  decodeAsText: boolean;      // false → materialiseTaskDocuments writes raw bytes
}

export const TASK_CONTEXT_MIME_CONFIG: Record<string, TaskContextMimeConfig> = {
  "text/markdown": { extensions: [".md", ".markdown"], requiresIndexing: true,  decodeAsText: true },
  "text/plain":    { extensions: [".txt"],              requiresIndexing: true,  decodeAsText: true },
  "image/jpeg":    { extensions: [".jpg", ".jpeg"],     requiresIndexing: false, decodeAsText: false },
  "image/png":     { extensions: [".png"],              requiresIndexing: false, decodeAsText: false },
};

export function isTaskContextMimeAllowed(mime: string): boolean {
  return mime in TASK_CONTEXT_MIME_CONFIG;
}

// Extension-fallback lookup — same role extensionMime() plays today, but table-driven.
export function taskContextExtensionMime(filename: string): string | null {
  const lower = filename.toLowerCase();
  for (const [mime, config] of Object.entries(TASK_CONTEXT_MIME_CONFIG)) {
    if (config.extensions.some((ext) => lower.endsWith(ext))) return mime;
  }
  return null;
}
```

Re-exported from `packages/core/src/index.ts` alongside the existing domain types and `models.ts` exports.

### Upload validation

```
apps/web/src/app/api/tasks/[taskId]/context-items/route.ts:

  ALLOWED_MIMES check → isTaskContextMimeAllowed(mime)
  extension fallback  → taskContextExtensionMime(filename)
```

`ContextDocumentsPanel.tsx` calls the same two functions, but only when `scope.kind === "task"`; for `scope.kind === "team"` the panel keeps exactly today's hand-written `["text/markdown", "text/plain"]` list, extension fallback, and `accept` string — the teams branch does not import from `TASK_CONTEXT_MIME_CONFIG` (see Design decisions). The task-scope `<input accept="...">` string is built by joining every `config.extensions` entry plus every key of `TASK_CONTEXT_MIME_CONFIG` (mirroring today's `".md,.markdown,.txt,text/markdown,text/plain"` shape, just table-derived instead of literal). Everything else in the route (Content-Length gate, 2 MB cap, blob store `put`, `insertContentBlob`, `createTaskContextItem`, 409-on-duplicate-sha, `enqueueTaskContextIngestJob`) is unchanged — none of it is mime-specific today.

### Ingestion

```
ingestTaskContextItem(itemId):
  ... existing status guard, markTaskContextItemIndexing ...
  bytes = blobStore.get(item.orgId, item.sha256)
  ... existing missing-blob handling ...

  if !TASK_CONTEXT_MIME_CONFIG[item.mime].requiresIndexing:
    markTaskContextItemIndexed(itemId)
    return                                    // no extractText, no chunking, no embedding

  // unchanged from here down: extractText → chunkDocument →
  // deleteTaskChunksForItem → embed in batches → insertTaskContextChunks →
  // markTaskContextItemIndexed | markTaskContextItemFailed
```

### Content-serving route (new)

```
GET /api/tasks/[taskId]/context-items/[itemId]/content
  → requireAuthContext; 401 if absent
  → item = getTaskContextItem(itemId); 404 if missing or item.orgId !== ctx.orgId
  → bytes = getBlobStore().get(item.orgId, item.sha256); 404 if missing
  → return new NextResponse(bytes, { headers: { "Content-Type": item.mime } })
```

### UI

`ContextDocumentsPanel`'s item row: for an item whose `mime` starts with `image/` (a plain string check is enough here — this is purely a rendering choice, not a policy decision, so it doesn't need the shared table), render a small `<img src={`${basePath}/${item.id}/content`} />` thumbnail to the left of the filename/size text, sized and cropped consistently (e.g. a fixed 40×40 box) regardless of the source image's dimensions. Non-image rows are visually unchanged. The empty-state icon, status badge, delete button, and error-row rendering are unaffected.

### Sandbox materialization

```
materialiseTaskDocuments(...):
  ... existing indexed-filter, budget loop, blob fetch, sanitiseDocumentName/deduplicate ...

  for each surviving item:
    if TASK_CONTEXT_MIME_CONFIG[item.mime].decodeAsText:
      files[path] = new TextDecoder().decode(bytes)   // unchanged
    else:
      files[path] = Buffer.from(bytes)          // raw bytes, no TextDecoder — covers
                                                 // images today, any future binary type
                                                 // (e.g. PDF) with no further table change

  ... existing mkdir -p + sandboxProvider.writeFiles(sandboxId, files) ...
```

`TASK_DOCUMENTS_BUDGET_BYTES` changes from `1024 * 1024` to `8 * 1024 * 1024`. `SandboxProvider.writeFiles`'s type becomes `Record<string, string | Buffer>`; `DockerSandboxProvider.writeFiles` needs no logic change (`tar.entry({ name: path }, contents)` already accepts either), only the type signature moves in step with the interface.

### Prompt composition

`formatEnvironmentForPrompt`'s wording for the `written` list (`prompt-composition.ts:80-99`) changes from framing every entry as a text file to read, to framing them as attached files to open — accurate for both a `.md` document and a `.png` screenshot, since Claude Code's file-reading tool handles both. The `omitted` sentence (files attached but not materialized) is unchanged in meaning.

## Testing

- **Unit.** `TASK_CONTEXT_MIME_CONFIG`/`isTaskContextMimeAllowed`/`taskContextExtensionMime` (accepts `.jpg`/`.jpeg`/`.png` and their declared/undeclared-mime variants, still rejects e.g. `.gif`; every entry's `extensions` round-trips back to its own mime key). `ingestTaskContextItem`: an `image/png`/`image/jpeg` item (`requiresIndexing: false`) reaches `indexed` with zero chunks inserted and without calling `extractText`, using the existing `TaskIngestDeps`-style stubs. `materialiseTaskDocuments`: an indexed image item (`decodeAsText: false`) is written as raw bytes (assert the written `Buffer` matches the source bytes exactly, not a UTF-8 round-trip), the 8 MB budget accepts a multi-image case that the old 1 MB budget would have partially omitted, and a mixed text+image task materializes both correctly with the shared directory/dedup logic unchanged.
- **DB/integration.** None new — `task_context_items`/`task_context_chunks` schema and repositories are unchanged; an `indexed` item with no chunk rows already exercises `countIndexedTaskContextItems` and `searchTaskContextChunks` correctly (they operate on the chunks table directly, not on a chunk-count assumption).
- **Component.** `ContextDocumentsPanel` with `scope: "task"`: accepts a `.png` file (asserted via a mocked `handleFile` path), renders a thumbnail `<img>` for an image item pointed at the correct content URL, and continues to render `scope: "team"` exactly as before (a `.png` selection is rejected client-side with the existing unsupported-type copy).
- **API route.** The new `GET .../[itemId]/content`: 401 unauthenticated, 404 for another org's item, 404 for a nonexistent item, 200 with the correct `Content-Type` and byte-for-byte body for an existing image item.
- **E2E.** Upload a `.png` to a task's context panel: item appears, reaches `indexed`, thumbnail renders. Team panel still shows no image option in its file picker.

## PR sequence

| # | PR | Contents | Demoable |
|---|---|---|---|
| 1 | **Shared table + upload + ingest** | New `packages/core/src/context-item-mime.ts` (`TASK_CONTEXT_MIME_CONFIG`), task route and `ContextDocumentsPanel` switched onto it, `ingestTaskContextItem`'s `requiresIndexing` branch | Yes — an image uploads, shows in the list, reaches `indexed` |
| 2 | **Content route + thumbnail** | New `GET .../[itemId]/content` route, `ContextDocumentsPanel` thumbnail rendering | Yes — uploaded images render as thumbnails |
| 3 | **Sandbox materialization** | `writeFiles` type widening + Buffer branch in `task-documents.ts`, `TASK_DOCUMENTS_BUDGET_BYTES` raised to 8 MB, `prompt-composition.ts` wording generalization | Yes — an agent run's sandbox contains the image file, and the injected prompt text mentions it |

PR 1 and PR 2 are independently demoable UI/API slices; PR 3 is where the feature's actual stated purpose (the agent "taking the image into account during development") becomes real.

## Risks

- **8 MB is an unmeasured raise, like the original 1 MB was.** It comfortably fits the stated JPEG/PNG use case at the existing 2 MB per-file cap, but if a task accumulates many large images, the tar payload and `putArchive` call in `docker-sandbox-provider.ts` grows accordingly — no load testing is done here.
- **Generalizing the prompt wording from "read" to "open" is a small behavioral change for existing text-only tasks too**, since the same code path renders both. Low risk — the meaning is equivalent for text files — but it does touch already-shipped prompt text.
- **Adding a mime to `TASK_CONTEXT_MIME_CONFIG` immediately changes upload, ingest, *and* materialization behavior at once.** That's the table's entire point, but it also means a mistake in one row (e.g. a future entry with `decodeAsText: true` for a format that isn't actually safe to UTF-8-decode) has a wider simultaneous blast radius than the old scattered-checks version did — there's now exactly one place to get it wrong, but getting it wrong there affects every consumer immediately. The unit tests on the table itself (see Testing) are the guard.
- **`packages/core` now carries a small piece of file-handling policy, not just entity shapes.** `MODEL_CATALOG` is the existing precedent (see Ground truth) so this isn't a new category of thing living there, but it's worth naming explicitly: `packages/core`'s role has quietly grown from "domain shapes" to "domain shapes plus small shared policy tables," and a reviewer unfamiliar with the `models.ts` precedent might reasonably ask why mime configuration isn't local to `apps/worker`.
