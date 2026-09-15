# Task-Scoped Image Uploads for Context Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a task's context-items uploader accept JPEG/PNG images alongside Markdown/text, storing and displaying them without RAG indexing, and materializing them into the run sandbox (like text documents already are) so the agent can view them during a run.

**Architecture:** A new shared per-mime capability table (`TASK_CONTEXT_MIME_CONFIG` in `packages/core`) records, per mime, which extensions map to it and two booleans — whether it needs RAG indexing and whether it's safely UTF-8-decodable. The upload route, the upload UI, the ingest worker, and the sandbox materializer all read from this one table instead of independently-reasoned checks. Team-level context items are completely untouched.

**Tech Stack:** Next.js 16 App Router (Route Handlers), React 19, Vitest 4 (`--project unit` for in-memory tests, `--project db-integration` for real-Postgres repository tests), Drizzle ORM, BullMQ, dockerode + tar-stream for sandbox file writes.

## Global Constraints

- Per-file upload cap stays `MAX_UPLOAD_BYTES = 2 * 1024 * 1024` (2 MB) for every task-scoped context item, text or image alike — unchanged.
- New accepted mimes are `image/jpeg` (`.jpg`, `.jpeg`) and `image/png` (`.png`) — **task scope only**. The teams route, `apps/web/src/app/api/teams/[teamId]/context-items/route.ts`, and `ContextDocumentsPanel`'s team-scope branch keep exactly today's `{ text/markdown, text/plain }` behavior — do not touch them.
- Images are never chunked, embedded, OCR'd, or captioned. No new `ContextItemStatus` value — an image reaches `indexed` directly with zero chunk rows.
- `TASK_DOCUMENTS_BUDGET_BYTES` (total bytes materialized into a run's sandbox) rises from `1024 * 1024` to `8 * 1024 * 1024`.
- The single source of truth for per-mime behavior is `TASK_CONTEXT_MIME_CONFIG` in `packages/core/src/context-item-mime.ts` — every consumer (upload route, client accept list, ingest, materialization) reads from it rather than re-deriving its own mime list or extension map.
- Design spec: `docs/superpowers/specs/2026-09-11-task-context-image-uploads-design.md`. Read it if a task's rationale needs more context than what's inlined below.

---

### Task 1: Shared task-context mime capability table

**Files:**
- Create: `packages/core/src/context-item-mime.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/context-item-mime.test.ts`

**Interfaces:**
- Produces: `TaskContextMimeConfig { extensions: string[]; requiresIndexing: boolean; decodeAsText: boolean }`, `TASK_CONTEXT_MIME_CONFIG: Record<string, TaskContextMimeConfig>`, `isTaskContextMimeAllowed(mime: string): boolean`, `taskContextExtensionMime(filename: string): string | null` — all exported from `@agentfactory/core` for Tasks 2, 4, 6, 8 to consume.

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/context-item-mime.test.ts
import { describe, expect, it } from "vitest";
import { TASK_CONTEXT_MIME_CONFIG, isTaskContextMimeAllowed, taskContextExtensionMime } from "../context-item-mime";

describe("TASK_CONTEXT_MIME_CONFIG", () => {
  it("marks text mimes as requiring indexing and decodable as text", () => {
    expect(TASK_CONTEXT_MIME_CONFIG["text/markdown"]).toMatchObject({ requiresIndexing: true, decodeAsText: true });
    expect(TASK_CONTEXT_MIME_CONFIG["text/plain"]).toMatchObject({ requiresIndexing: true, decodeAsText: true });
  });

  it("marks image mimes as not requiring indexing and not decodable as text", () => {
    expect(TASK_CONTEXT_MIME_CONFIG["image/jpeg"]).toMatchObject({ requiresIndexing: false, decodeAsText: false });
    expect(TASK_CONTEXT_MIME_CONFIG["image/png"]).toMatchObject({ requiresIndexing: false, decodeAsText: false });
  });

  it("every entry's extensions resolve back to its own mime", () => {
    for (const [mime, config] of Object.entries(TASK_CONTEXT_MIME_CONFIG)) {
      for (const ext of config.extensions) {
        expect(taskContextExtensionMime(`file${ext}`)).toBe(mime);
      }
    }
  });
});

describe("isTaskContextMimeAllowed", () => {
  it("allows every configured mime", () => {
    for (const mime of Object.keys(TASK_CONTEXT_MIME_CONFIG)) {
      expect(isTaskContextMimeAllowed(mime)).toBe(true);
    }
  });

  it("rejects a mime that isn't configured", () => {
    expect(isTaskContextMimeAllowed("application/pdf")).toBe(false);
    expect(isTaskContextMimeAllowed("image/gif")).toBe(false);
  });
});

describe("taskContextExtensionMime", () => {
  it("is case-insensitive", () => {
    expect(taskContextExtensionMime("SCREENSHOT.PNG")).toBe("image/png");
  });

  it("returns null for an unrecognised extension", () => {
    expect(taskContextExtensionMime("archive.zip")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit packages/core/src/__tests__/context-item-mime.test.ts`
Expected: FAIL — `Cannot find module '../context-item-mime'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/src/context-item-mime.ts

// Single source of truth for how a task context item's mime behaves, read by both apps/web
// (upload validation, client accept list) and apps/worker (ingest, sandbox materialization) so
// the two questions below never drift out of sync across files. See the design doc's "one
// shared per-mime capability table, not independently-reasoned checks" for why this is a plain
// data table rather than a Strategy-pattern class hierarchy: the two axes that vary per mime are
// booleans, not distinct algorithms.
export interface TaskContextMimeConfig {
  extensions: string[];
  // false → ingestTaskContextItem skips extraction/chunking/embedding and marks the item
  // "indexed" directly.
  requiresIndexing: boolean;
  // false → materialiseTaskDocuments writes the blob's raw bytes into the sandbox instead of
  // UTF-8-decoding them.
  decodeAsText: boolean;
}

export const TASK_CONTEXT_MIME_CONFIG: Record<string, TaskContextMimeConfig> = {
  "text/markdown": { extensions: [".md", ".markdown"], requiresIndexing: true, decodeAsText: true },
  "text/plain": { extensions: [".txt"], requiresIndexing: true, decodeAsText: true },
  "image/jpeg": { extensions: [".jpg", ".jpeg"], requiresIndexing: false, decodeAsText: false },
  "image/png": { extensions: [".png"], requiresIndexing: false, decodeAsText: false },
};

export function isTaskContextMimeAllowed(mime: string): boolean {
  return mime in TASK_CONTEXT_MIME_CONFIG;
}

// Extension-fallback lookup for when a browser doesn't reliably populate File.type (the same
// problem the team upload route already works around for .md files) — table-driven instead of
// a hand-written if/else chain.
export function taskContextExtensionMime(filename: string): string | null {
  const lower = filename.toLowerCase();
  for (const [mime, config] of Object.entries(TASK_CONTEXT_MIME_CONFIG)) {
    if (config.extensions.some((ext) => lower.endsWith(ext))) return mime;
  }
  return null;
}
```

Modify `packages/core/src/index.ts` — add one line to the existing barrel:

```ts
export * from "./domain";
export * from "./events";
export * from "./models";
export * from "./shared-context";
export * from "./context-item-mime";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --project unit packages/core/src/__tests__/context-item-mime.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck the package**

Run: `pnpm --filter @agentfactory/core typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context-item-mime.ts packages/core/src/index.ts packages/core/src/__tests__/context-item-mime.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add shared task-context mime capability table

TASK_CONTEXT_MIME_CONFIG records, per mime, its extensions and whether
it needs RAG indexing / is UTF-8-decodable — the single source of truth
the upload route, upload UI, ingest worker, and sandbox materializer
will all read from instead of independently-reasoned checks.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Task upload route accepts images

**Files:**
- Modify: `apps/web/src/app/api/tasks/[taskId]/context-items/route.ts:1-27,66-73`
- Test: `apps/web/src/app/api/tasks/[taskId]/context-items/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `isTaskContextMimeAllowed(mime: string): boolean`, `taskContextExtensionMime(filename: string): string | null` from Task 1.
- Produces: no new exports; `GET`/`POST`/`MAX_UPLOAD_BYTES` keep their existing names and shapes.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/app/api/tasks/[taskId]/context-items/__tests__/route.test.ts`, inside the `describe("POST /api/tasks/[taskId]/context-items", ...)` block (after the existing `"rejects a mime outside the allowlist"` test):

```ts
  it("accepts a JPEG file and returns 201", async () => {
    const res = await POST(
      multipartRequest({ filename: "screenshot.jpg", type: "image/jpeg", content: "\xFF\xD8\xFF" }),
      params(),
    );

    expect(res.status).toBe(201);
    const [, , mime] = putMock.mock.calls[0];
    expect(mime).toBe("image/jpeg");
  });

  it("accepts a PNG file and returns 201", async () => {
    const res = await POST(
      multipartRequest({ filename: "diagram.png", type: "image/png", content: "\x89PNG" }),
      params(),
    );

    expect(res.status).toBe(201);
    const [, , mime] = putMock.mock.calls[0];
    expect(mime).toBe("image/png");
  });

  it("falls back to the extension when a browser mis-declares an image's mime", async () => {
    const res = await POST(
      multipartRequest({ filename: "diagram.png", type: "application/octet-stream", content: "\x89PNG" }),
      params(),
    );

    expect(res.status).toBe(201);
    const [, , mime] = putMock.mock.calls[0];
    expect(mime).toBe("image/png");
  });

  it("still rejects a mime that isn't in the task's allowlist, e.g. GIF", async () => {
    const res = await POST(
      multipartRequest({ filename: "anim.gif", type: "image/gif", content: "GIF89a" }),
      params(),
    );

    expect(res.status).toBe(415);
    expect(putMock).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run --project unit apps/web/src/app/api/tasks/\[taskId\]/context-items/__tests__/route.test.ts`
Expected: the 3 new "accepts"/"falls back" tests FAIL with 415 instead of 201 (images are not yet in `ALLOWED_MIMES`); the GIF test already passes.

- [ ] **Step 3: Write the implementation**

Replace lines 18-27 of `apps/web/src/app/api/tasks/[taskId]/context-items/route.ts`:

```ts
// BEFORE
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

const ALLOWED_MIMES = new Set(["text/markdown", "text/plain"]);

function extensionMime(filename: string): "text/markdown" | "text/plain" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return null;
}
```

```ts
// AFTER
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
```

Add the import at the top of the file (alongside the existing `@agentfactory/db`/`@agentfactory/queue`/`@agentfactory/storage` imports):

```ts
import { isTaskContextMimeAllowed, taskContextExtensionMime } from "@agentfactory/core";
```

Replace the mime-check block (originally lines 66-73):

```ts
// BEFORE
  let mime = file.type;
  if (!ALLOWED_MIMES.has(mime)) {
    const fallback = extensionMime(file.name);
    if (!fallback) {
      return NextResponse.json({ error: "Only Markdown and plain text files are supported" }, { status: 415 });
    }
    mime = fallback;
  }
```

```ts
// AFTER
  let mime = file.type;
  if (!isTaskContextMimeAllowed(mime)) {
    const fallback = taskContextExtensionMime(file.name);
    if (!fallback) {
      return NextResponse.json(
        { error: "Only Markdown, plain text, JPEG, and PNG files are supported" },
        { status: 415 },
      );
    }
    mime = fallback;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit apps/web/src/app/api/tasks/\[taskId\]/context-items/__tests__/route.test.ts`
Expected: PASS (all tests, including the 4 new ones)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/api/tasks/\[taskId\]/context-items/route.ts apps/web/src/app/api/tasks/\[taskId\]/context-items/__tests__/route.test.ts
git commit -m "$(cat <<'EOF'
feat(web): accept JPEG/PNG uploads on the task context-items route

Switches the task route's mime validation onto the shared
TASK_CONTEXT_MIME_CONFIG table instead of its own literal set, which
now includes image/jpeg and image/png alongside markdown/plain text.
The teams route is untouched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Content-serving route for a task context item's raw bytes

**Files:**
- Modify: `packages/db/src/repositories/task-context-items.ts:62-67` (add a function after `getTaskContextItem`)
- Test: `packages/db/src/__tests__/repositories/task-context-items.test.ts`
- Create: `apps/web/src/app/api/tasks/[taskId]/context-items/[itemId]/content/route.ts`
- Test: `apps/web/src/app/api/tasks/[taskId]/context-items/[itemId]/content/__tests__/route.test.ts`

**Interfaces:**
- Produces: `getTaskContextItemForOrg(id: number, orgId: number): Promise<TaskContextItem | undefined>` from `@agentfactory/db`, and a `GET` handler at `/api/tasks/[taskId]/context-items/[itemId]/content` — Task 5 (thumbnail rendering) points an `<img src>` at this URL.

**Prerequisite:** Steps 1-4 below run against the `db-integration` Vitest project, which needs a real scratch Postgres. If `pnpm exec vitest run --project db-integration ...` fails with `DATABASE_URL is not set`, copy `.env.test.example` to `.env.test.local` at the repo root first (it already points at `postgres://agentfactory:agentfactory@localhost:5432/agentfactory_test`) and make sure that Postgres instance is running and migrated — this is existing repo setup, not something this task introduces. Steps 5-10 (the web route) need no database.

- [ ] **Step 1: Write the failing repository test**

Add to `packages/db/src/__tests__/repositories/task-context-items.test.ts` — first, add `getTaskContextItemForOrg` to the existing import block at the top of the file:

```ts
// BEFORE
import {
  countIndexedTaskContextItems,
  createTaskContextItem,
  deleteTaskContextItemForOrg,
  getTaskContextItem,
  listTaskContextItemsForOrg,
  markTaskContextItemIndexed,
} from "../../repositories/task-context-items.js";
```

```ts
// AFTER
import {
  countIndexedTaskContextItems,
  createTaskContextItem,
  deleteTaskContextItemForOrg,
  getTaskContextItem,
  getTaskContextItemForOrg,
  listTaskContextItemsForOrg,
  markTaskContextItemIndexed,
} from "../../repositories/task-context-items.js";
```

Then add this test inside `describe("task-context-items repository", ...)`, after the `"creates a pending item and reads it back"` test:

```ts
  it("gets an item scoped to its own org, and nothing for another org", async () => {
    const { org, task } = await setupTaskWithBlob();
    const otherOrg = await insertOrg();
    const item = await createTaskContextItem({
      taskId: task.id, orgId: org.id, title: "Design doc", sizeBytes: 42, sha256: SHA_A, mime: "text/markdown",
    });
    if (!item) throw new Error("expected the item to be created");

    await expect(getTaskContextItemForOrg(item.id, org.id)).resolves.toEqual(item);
    await expect(getTaskContextItemForOrg(item.id, otherOrg.id)).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project db-integration packages/db/src/__tests__/repositories/task-context-items.test.ts`
Expected: FAIL — `getTaskContextItemForOrg is not a function` (this project needs a local Postgres; use the same setup the other `db-integration` tests already rely on)

- [ ] **Step 3: Write the repository function**

Insert into `packages/db/src/repositories/task-context-items.ts`, right after `getTaskContextItem` (after line 67):

```ts
// Org-scoped by the denormalized column, exactly like listTaskContextItemsForOrg — unlike
// getTaskContextItem (worker-only, unscoped), this is for the content-serving route, which
// receives both ids from the URL and must not serve another tenant's blob just because a
// numeric itemId happened to guess right.
export async function getTaskContextItemForOrg(
  id: number,
  orgId: number,
): Promise<TaskContextItem | undefined> {
  const [row] = await db
    .select()
    .from(taskContextItems)
    .where(and(eq(taskContextItems.id, id), eq(taskContextItems.orgId, orgId)));
  return row ? toItem(row) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --project db-integration packages/db/src/__tests__/repositories/task-context-items.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing route test**

Create `apps/web/src/app/api/tasks/[taskId]/context-items/[itemId]/content/__tests__/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTaskContextItemForOrgMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getTaskContextItemForOrg: (...args: unknown[]) => getTaskContextItemForOrgMock(...args),
}));
const getBlobMock = vi.fn();
vi.mock("@agentfactory/storage", () => ({
  createBlobStore: () => ({ put: vi.fn(), get: (...args: unknown[]) => getBlobMock(...args) }),
}));
const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));

import { GET } from "../route";

function params(itemId = "9") {
  return { params: Promise.resolve({ taskId: "1", itemId }) };
}

const ITEM = {
  id: 9,
  taskId: 1,
  orgId: 1,
  title: "screenshot.png",
  sizeBytes: 4,
  sha256: "a".repeat(64),
  mime: "image/png",
  source: "upload",
  status: "indexed",
  createdAt: "2026-09-01T10:00:00.000Z",
};

beforeEach(() => {
  getTaskContextItemForOrgMock.mockReset();
  getBlobMock.mockReset();
  requireAuthContextMock.mockReset();
  requireAuthContextMock.mockResolvedValue({ user: { id: 5 }, orgId: 1 });
});

describe("GET /api/tasks/[taskId]/context-items/[itemId]/content", () => {
  it("streams the blob's bytes with the item's mime as Content-Type", async () => {
    getTaskContextItemForOrgMock.mockResolvedValue(ITEM);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    getBlobMock.mockResolvedValue(bytes);

    const res = await GET(new Request("http://localhost/api/tasks/1/context-items/9/content"), params());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(getTaskContextItemForOrgMock).toHaveBeenCalledWith(9, 1);
    expect(getBlobMock).toHaveBeenCalledWith(1, "a".repeat(64));
  });

  it("answers 404 when the item doesn't exist or belongs to another org", async () => {
    getTaskContextItemForOrgMock.mockResolvedValue(undefined);

    const res = await GET(new Request("http://localhost/api/tasks/1/context-items/9/content"), params());

    expect(res.status).toBe(404);
    expect(getBlobMock).not.toHaveBeenCalled();
  });

  it("answers 404 when the item exists but its blob is missing", async () => {
    getTaskContextItemForOrgMock.mockResolvedValue(ITEM);
    getBlobMock.mockResolvedValue(undefined);

    const res = await GET(new Request("http://localhost/api/tasks/1/context-items/9/content"), params());

    expect(res.status).toBe(404);
  });

  it("answers 401 without touching the db or blob store when unauthorized", async () => {
    requireAuthContextMock.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/tasks/1/context-items/9/content"), params());

    expect(res.status).toBe(401);
    expect(getTaskContextItemForOrgMock).not.toHaveBeenCalled();
    expect(getBlobMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit apps/web/src/app/api/tasks/\[taskId\]/context-items/\[itemId\]/content/__tests__/route.test.ts`
Expected: FAIL — cannot find module `../route`

- [ ] **Step 7: Write the route**

Create `apps/web/src/app/api/tasks/[taskId]/context-items/[itemId]/content/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getTaskContextItemForOrg } from "@agentfactory/db";
import { createBlobStore } from "@agentfactory/storage";
import { requireAuthContext } from "@/server/auth";

let blobStore: ReturnType<typeof createBlobStore> | undefined;
function getBlobStore() {
  if (!blobStore) blobStore = createBlobStore();
  return blobStore;
}

// Generic content-serving route, not image-specific: it streams whatever bytes and mime an item
// has. Only the UI's choice to render an <img> for image rows (ContextDocumentsPanel) makes this
// "the image route" in practice.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string; itemId: string }> },
) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { itemId } = await params;
  const item = await getTaskContextItemForOrg(Number(itemId), ctx.orgId);
  // 404, not 403: an item in another org must not be distinguishable from one that isn't there.
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bytes = await getBlobStore().get(item.orgId, item.sha256);
  if (!bytes) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(bytes, { headers: { "Content-Type": item.mime } });
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm exec vitest run --project unit apps/web/src/app/api/tasks/\[taskId\]/context-items/\[itemId\]/content/__tests__/route.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @agentfactory/db typecheck && pnpm --filter @agentfactory/web typecheck`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/repositories/task-context-items.ts packages/db/src/__tests__/repositories/task-context-items.test.ts apps/web/src/app/api/tasks/\[taskId\]/context-items/\[itemId\]/content
git commit -m "$(cat <<'EOF'
feat(web,db): add a content-serving route for task context items

GET /api/tasks/[taskId]/context-items/[itemId]/content streams an
item's raw bytes with its stored mime as Content-Type, org-scoped via
the new getTaskContextItemForOrg repository function. Generic, not
image-specific — the UI's choice to use it for <img src> thumbnails
comes next.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ContextDocumentsPanel accepts images at task scope

**Files:**
- Modify: `apps/web/src/components/ContextDocumentsPanel.tsx:1-183`
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` (taskDetail namespace, lines ~368-372)
- Test: `apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx`

**Interfaces:**
- Consumes: `TASK_CONTEXT_MIME_CONFIG`, `isTaskContextMimeAllowed`, `taskContextExtensionMime` from Task 1.
- Produces: no new exports; `ContextDocumentsPanel`/`ContextDocumentsScope` keep their existing names.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx`, inside `describe("ContextDocumentsPanel with task scope", ...)`:

```ts
  it("accepts a PNG file and uploads it to the task-scoped route", async () => {
    apiFetchMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ ...TASK_ITEM, id: 3, title: "screenshot.png", mime: "image/png", sizeBytes: 9 });
    renderPanel(TASK_SCOPE);
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    const file = new File(["\x89PNG"], "screenshot.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("screenshot.png")).toBeInTheDocument());
    const [path, init] = apiFetchMock.mock.calls[1] as [string, RequestInit];
    expect(path).toBe("/api/tasks/9/context-items");
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("refuses a file type the task uploader still doesn't accept", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderPanel(TASK_SCOPE);
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    const file = new File(["GIF89a"], "anim.gif", { type: "image/gif" });
    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [file] } });

    await waitFor(() =>
      expect(
        screen.getByText("Only Markdown (.md), plain text (.txt), JPEG, and PNG files can be uploaded."),
      ).toBeInTheDocument(),
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
```

Add to `describe("ContextDocumentsPanel", ...)` (the team-scope suite):

```ts
  it("still refuses images at team scope", async () => {
    apiFetchMock.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByText("No documents yet")).toBeInTheDocument());

    const file = new File(["\x89PNG"], "screenshot.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Upload document"), { target: { files: [file] } });

    await waitFor(() =>
      expect(
        screen.getByText("Only Markdown (.md) and plain text (.txt) files can be uploaded."),
      ).toBeInTheDocument(),
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run --project unit apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx`
Expected: the two new task-scope tests FAIL (PNG/GIF both currently rejected the same way at task scope, and the rejection copy doesn't yet mention images); the team-scope test already passes.

- [ ] **Step 3: Write the implementation**

Replace lines 15-19 of `apps/web/src/components/ContextDocumentsPanel.tsx` (the import block) — add a non-type import next to the existing type-only one:

```ts
// BEFORE
import type { OrgMember, TaskContextItem, TeamContextItem } from "@agentfactory/core";
```

```ts
// AFTER
import { TASK_CONTEXT_MIME_CONFIG, isTaskContextMimeAllowed, taskContextExtensionMime } from "@agentfactory/core";
import type { OrgMember, TaskContextItem, TeamContextItem } from "@agentfactory/core";
```

Replace the `SCOPE_COPY_KEYS` block (originally lines 34-48):

```ts
// BEFORE
const SCOPE_COPY_KEYS: Record<
  ContextDocumentsScope["kind"],
  { emptySub: TranslationKey; uploadFailed: TranslationKey; loadError: TranslationKey }
> = {
  team: {
    emptySub: "teamsV2.documentsEmptySub",
    uploadFailed: "teamsV2.documentsUploadFailed",
    loadError: "teamsV2.documentsLoadError",
  },
  task: {
    emptySub: "taskDetail.documentsEmptySub",
    uploadFailed: "taskDetail.documentsUploadFailed",
    loadError: "taskDetail.documentsLoadError",
  },
};
```

```ts
// AFTER
const SCOPE_COPY_KEYS: Record<
  ContextDocumentsScope["kind"],
  {
    emptySub: TranslationKey;
    uploadFailed: TranslationKey;
    loadError: TranslationKey;
    unsupportedType: TranslationKey;
  }
> = {
  team: {
    emptySub: "teamsV2.documentsEmptySub",
    uploadFailed: "teamsV2.documentsUploadFailed",
    loadError: "teamsV2.documentsLoadError",
    unsupportedType: "teamsV2.documentsUnsupportedType",
  },
  task: {
    emptySub: "taskDetail.documentsEmptySub",
    uploadFailed: "taskDetail.documentsUploadFailed",
    loadError: "taskDetail.documentsLoadError",
    unsupportedType: "taskDetail.documentsUnsupportedType",
  },
};
```

Replace the mime constants block (originally lines 50-66):

```ts
// BEFORE
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIMES = ["text/markdown", "text/plain"];

function extensionMime(filename: string): "text/markdown" | "text/plain" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return null;
}
```

```ts
// AFTER
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const TEAM_ALLOWED_MIMES = ["text/markdown", "text/plain"];

function teamExtensionMime(filename: string): "text/markdown" | "text/plain" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return null;
}

// Team scope keeps its own literal mime set unchanged; task scope reads from the shared table.
// Deliberately not unified — see the design doc's "the teams route does not adopt this table".
function isAllowedMime(scope: ContextDocumentsScope, mime: string): boolean {
  return scope.kind === "task" ? isTaskContextMimeAllowed(mime) : TEAM_ALLOWED_MIMES.includes(mime);
}

function extensionMimeFor(scope: ContextDocumentsScope, filename: string): string | null {
  return scope.kind === "task" ? taskContextExtensionMime(filename) : teamExtensionMime(filename);
}

function acceptFor(scope: ContextDocumentsScope): string {
  if (scope.kind !== "task") return ".md,.markdown,.txt,text/markdown,text/plain";
  const extensions = Object.values(TASK_CONTEXT_MIME_CONFIG).flatMap((config) => config.extensions);
  const mimes = Object.keys(TASK_CONTEXT_MIME_CONFIG);
  return [...extensions, ...mimes].join(",");
}
```

Replace the mime-check block inside `handleFile` (originally lines 122-130):

```ts
// BEFORE
    let mime = file.type;
    if (!ALLOWED_MIMES.includes(mime)) {
      const fallback = extensionMime(file.name);
      if (!fallback) {
        setErrorKey("teamsV2.documentsUnsupportedType");
        return;
      }
      mime = fallback;
    }
```

```ts
// AFTER
    let mime = file.type;
    if (!isAllowedMime(scope, mime)) {
      const fallback = extensionMimeFor(scope, file.name);
      if (!fallback) {
        setErrorKey(copy.unsupportedType);
        return;
      }
      mime = fallback;
    }
```

Replace the `accept` attribute on the `<input>` (originally line 175):

```tsx
// BEFORE
          accept=".md,.markdown,.txt,text/markdown,text/plain"
```

```tsx
// AFTER
          accept={acceptFor(scope)}
```

Now add the two new i18n keys. In `apps/web/src/lib/i18n/dictionaries/en.ts`, inside the `taskDetail` object, replace:

```ts
// BEFORE
    documentsEmptySub: "Upload a Markdown or text file to give this task's agent something to draw on.",
    documentsUploadFailed: "Couldn't upload that file — it may already be attached to this task.",
    documentsLoadError: "Couldn't load this task's documents.",
  },
```

```ts
// AFTER
    documentsEmptySub: "Upload a Markdown or text file to give this task's agent something to draw on.",
    documentsUploadFailed: "Couldn't upload that file — it may already be attached to this task.",
    documentsLoadError: "Couldn't load this task's documents.",
    documentsUnsupportedType: "Only Markdown (.md), plain text (.txt), JPEG, and PNG files can be uploaded.",
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ContextDocumentsPanel.tsx apps/web/src/lib/i18n/dictionaries/en.ts apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): let the task-scoped uploader accept JPEG/PNG

ContextDocumentsPanel's allowed-mime list, extension fallback, and
accept attribute become scope-conditional: task scope now reads from
TASK_CONTEXT_MIME_CONFIG (docs + images), team scope keeps its own
unchanged text-only literals.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Image thumbnail in the context items list

**Files:**
- Modify: `apps/web/src/components/ContextDocumentsPanel.tsx:199-231`
- Test: `apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx`

**Interfaces:**
- Consumes: the content-serving route from Task 3 (`GET {basePath}/[itemId]/content`).
- Produces: nothing new for later tasks — this is a leaf UI change.

- [ ] **Step 1: Write the failing tests**

Add to `describe("ContextDocumentsPanel with task scope", ...)` in `ContextDocumentsPanel.test.tsx`:

```ts
  it("renders a thumbnail for an image item pointed at the content route", async () => {
    apiFetchMock.mockResolvedValue([{ ...TASK_ITEM, mime: "image/png", title: "screenshot.png" }]);
    renderPanel(TASK_SCOPE);

    await waitFor(() => expect(screen.getByText("screenshot.png")).toBeInTheDocument());
    const thumb = screen.getByAltText("screenshot.png") as HTMLImageElement;
    expect(thumb.src).toContain("/api/tasks/9/context-items/1/content");
  });

  it("renders no thumbnail for a non-image item", async () => {
    apiFetchMock.mockResolvedValue([TASK_ITEM]);
    renderPanel(TASK_SCOPE);

    await waitFor(() => expect(screen.getByText("Migration runbook")).toBeInTheDocument());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run --project unit apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx`
Expected: the first new test FAILS (`Unable to find an element with the alt text: screenshot.png`); the second already passes (nothing renders an `<img>` yet either way).

- [ ] **Step 3: Write the implementation**

In the item row rendering (originally lines 204-211 of `ContextDocumentsPanel.tsx`), insert an `<img>` before the title/size block:

```tsx
// BEFORE
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-[var(--color-neutral-200)]">{item.title}</div>
                      <div className="text-xs text-[var(--color-neutral-500)]">
                        {t("teamsV2.documentsSize", { size: (item.sizeBytes / 1024).toFixed(1) })}
                        {uploader ? ` · ${t("teamsV2.documentsUploadedBy", { name: uploader.name })}` : ""}
                      </div>
                    </div>
```

```tsx
// AFTER
                  <div className="flex items-center gap-3 px-4 py-3">
                    {item.mime.startsWith("image/") && (
                      <img
                        src={`${basePath}/${item.id}/content`}
                        alt={item.title}
                        className="h-10 w-10 shrink-0 rounded-[var(--radius-sm)] object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-[var(--color-neutral-200)]">{item.title}</div>
                      <div className="text-xs text-[var(--color-neutral-500)]">
                        {t("teamsV2.documentsSize", { size: (item.sizeBytes / 1024).toFixed(1) })}
                        {uploader ? ` · ${t("teamsV2.documentsUploadedBy", { name: uploader.name })}` : ""}
                      </div>
                    </div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ContextDocumentsPanel.tsx apps/web/src/components/__tests__/ContextDocumentsPanel.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): show a thumbnail for image context items

Renders a 40x40 <img> from the new content-serving route for any item
whose mime starts with image/. A rendering-only check, not a policy
decision, so it doesn't need the shared mime table.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Ingest skips indexing for images

**Files:**
- Modify: `apps/worker/src/context-ingest.ts:1,175-220`
- Test: `apps/worker/src/__tests__/task-context-ingest.test.ts`

**Interfaces:**
- Consumes: `TASK_CONTEXT_MIME_CONFIG` from Task 1.
- Produces: no new exports; `ingestTaskContextItem` keeps its existing signature.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/__tests__/task-context-ingest.test.ts`, inside `describe("ingestTaskContextItem", ...)`:

```ts
  it("marks an image item indexed without touching the blob store, chunker, or embedder", async () => {
    for (const mime of ["image/jpeg", "image/png"]) {
      const deps = makeDeps(makeItem({ mime }));

      await ingestTaskContextItem(5, deps);

      expect(deps.blobStore.get).not.toHaveBeenCalled();
      expect(chunkDocumentMock).not.toHaveBeenCalled();
      expect(deps.embedder.embedDocuments).not.toHaveBeenCalled();
      expect(deps.insertTaskContextChunks).not.toHaveBeenCalled();
      expect(deps.markTaskContextItemIndexed).toHaveBeenCalledWith(5);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit apps/worker/src/__tests__/task-context-ingest.test.ts`
Expected: FAIL — today an `image/jpeg`/`image/png` item falls through to `extractText`, which throws `UnsupportedMimeError`, so `markTaskContextItemIndexed` is never called (the item lands `failed` instead).

- [ ] **Step 3: Write the implementation**

Replace the import at the top of `apps/worker/src/context-ingest.ts` (line 1):

```ts
// BEFORE
import type { TaskContextItem, TeamContextItem } from "@agentfactory/core";
```

```ts
// AFTER
import { TASK_CONTEXT_MIME_CONFIG } from "@agentfactory/core";
import type { TaskContextItem, TeamContextItem } from "@agentfactory/core";
```

In `ingestTaskContextItem`, insert a skip branch right after `markTaskContextItemIndexing` (originally the `try` block starting at line 175):

```ts
// BEFORE
  try {
    await d.markTaskContextItemIndexing(itemId);

    const blobStore = d.blobStore ?? createBlobStore();
```

```ts
// AFTER
  try {
    await d.markTaskContextItemIndexing(itemId);

    // A mime not in the table (e.g. a stray "application/pdf" test item, or any future upload
    // whose extraction genuinely fails) falls through unchanged to extractText below, which is
    // what throws UnsupportedMimeError and lands the item as "failed" — this only short-circuits
    // mimes the table explicitly says don't need indexing.
    const mimeConfig = TASK_CONTEXT_MIME_CONFIG[item.mime];
    if (mimeConfig && !mimeConfig.requiresIndexing) {
      await d.markTaskContextItemIndexed(itemId);
      return;
    }

    const blobStore = d.blobStore ?? createBlobStore();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit apps/worker/src/__tests__/task-context-ingest.test.ts`
Expected: PASS (all tests, including the new one and the pre-existing `"marks the item failed when the mime is not one we extract"` test using `application/pdf`, which must still fail-through unchanged)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/context-ingest.ts apps/worker/src/__tests__/task-context-ingest.test.ts
git commit -m "$(cat <<'EOF'
feat(worker): skip RAG indexing for image task context items

ingestTaskContextItem marks an image indexed directly, without
extraction, chunking, or embedding, keyed off
TASK_CONTEXT_MIME_CONFIG[item.mime].requiresIndexing. A mime outside
the table (unconfigured or genuinely unsupported) still falls through
to extractText's existing failure path unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Sandbox writeFiles accepts binary content

**Files:**
- Modify: `apps/worker/src/sandbox/types.ts:28`
- Modify: `apps/worker/src/sandbox/docker-sandbox-provider.ts:222`

**Interfaces:**
- Produces: `SandboxProvider.writeFiles(id: string, files: Record<string, string | Buffer>): Promise<void>` — Task 8 needs this widened type to write image bytes without a compile error.

There is no existing unit test file for `docker-sandbox-provider.ts` (it talks to a real Docker daemon) or for the `SandboxProvider` interface itself — this task is a pure type change, verified by `tsc` and by Task 8's tests compiling and passing against the new signature.

- [ ] **Step 1: Widen the interface**

In `apps/worker/src/sandbox/types.ts`, replace line 28:

```ts
// BEFORE
  writeFiles(id: string, files: Record<string, string>): Promise<void>;
```

```ts
// AFTER
  writeFiles(id: string, files: Record<string, string | Buffer>): Promise<void>;
```

- [ ] **Step 2: Widen the implementation's signature**

In `apps/worker/src/sandbox/docker-sandbox-provider.ts`, replace line 222:

```ts
// BEFORE
  async writeFiles(id: string, files: Record<string, string>): Promise<void> {
```

```ts
// AFTER
  async writeFiles(id: string, files: Record<string, string | Buffer>): Promise<void> {
```

No other change is needed in the function body — `tar.entry({ name: path }, contents)` (the next 5 lines, unchanged) already accepts a `Buffer` exactly as well as a `string` at runtime; only the type signature was too narrow.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: no errors

- [ ] **Step 4: Run the existing worker unit suite to confirm nothing broke**

Run: `pnpm exec vitest run --project unit apps/worker/src/__tests__/task-documents.test.ts`
Expected: PASS (all existing tests — `fakeSandbox`'s `writeFiles: vi.fn()` stub is untyped enough that the interface widening doesn't affect it)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/sandbox/types.ts apps/worker/src/sandbox/docker-sandbox-provider.ts
git commit -m "$(cat <<'EOF'
feat(worker): widen SandboxProvider.writeFiles to accept Buffer

Type-only change — tar-stream's entry() already writes a Buffer's
bytes verbatim at runtime. Needed so materialiseTaskDocuments can write
image bytes without UTF-8-decoding them.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Sandbox materialization writes images as raw bytes, budget raised to 8 MB

**Files:**
- Modify: `apps/worker/src/task-documents.ts:1,9-13,91,110-116`
- Test: `apps/worker/src/__tests__/task-documents.test.ts`

**Interfaces:**
- Consumes: `TASK_CONTEXT_MIME_CONFIG` from Task 1, the widened `writeFiles` from Task 7.
- Produces: `TASK_DOCUMENTS_BUDGET_BYTES` keeps its name but changes value; `materialiseTaskDocuments`'s signature and `MaterialisedTaskDocuments` shape are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/__tests__/task-documents.test.ts`, inside `describe("materialiseTaskDocuments", ...)`:

```ts
  it("writes an image item's raw bytes instead of UTF-8-decoding them", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8]);
    listTaskContextItemsForOrgMock.mockResolvedValue([
      item({ id: 1, title: "screenshot.png", mime: "image/png" }),
    ]);
    const writeFiles = vi.fn();
    const provider = fakeSandbox({ writeFiles });

    await materialiseTaskDocuments(provider, "sbx", 70, 1, {
      blobStore: { put: vi.fn(), get: vi.fn(async () => pngBytes) },
    });

    const written = writeFiles.mock.calls[0][1][`${TASK_DOCUMENT_DIR}/screenshot.png`];
    expect(written).toBeInstanceOf(Buffer);
    expect(new Uint8Array(written)).toEqual(pngBytes);
  });

  it("still UTF-8-decodes a text document alongside an image in the same task", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([
      item({ id: 1, title: "notes.md", mime: "text/markdown" }),
      item({ id: 2, title: "screenshot.png", mime: "image/png" }),
    ]);
    const writeFiles = vi.fn();
    const provider = fakeSandbox({ writeFiles });
    // Both items resolve the same fixture bytes — this test is about the per-item mime branch,
    // not about distinct content per file.
    const bytes = new TextEncoder().encode("# Notes");

    await materialiseTaskDocuments(provider, "sbx", 70, 1, {
      blobStore: { put: vi.fn(), get: vi.fn(async () => bytes) },
    });

    const files = writeFiles.mock.calls[0][1];
    expect(files[`${TASK_DOCUMENT_DIR}/notes.md`]).toBe("# Notes");
    expect(files[`${TASK_DOCUMENT_DIR}/screenshot.png`]).toBeInstanceOf(Buffer);
  });

  it("raises the total budget to 8 MB so a couple of legitimately-uploaded images both fit", async () => {
    expect(TASK_DOCUMENTS_BUDGET_BYTES).toBe(8 * 1024 * 1024);

    listTaskContextItemsForOrgMock.mockResolvedValue([
      item({ id: 1, title: "a.png", mime: "image/png", sizeBytes: 1_500_000 }),
      item({ id: 2, title: "b.png", mime: "image/png", sizeBytes: 1_500_000 }),
    ]);
    const provider = fakeSandbox();

    const result = await materialiseTaskDocuments(provider, "sbx", 70, 1, {
      blobStore: { put: vi.fn(), get: vi.fn(async () => new Uint8Array(10)) },
    });

    expect(result.written).toEqual([`${TASK_DOCUMENT_DIR}/a.png`, `${TASK_DOCUMENT_DIR}/b.png`]);
    expect(result.omitted).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run --project unit apps/worker/src/__tests__/task-documents.test.ts`
Expected: the first two new tests FAIL (`written` is a UTF-8-decoded, corrupted string, not a `Buffer`); the budget test FAILS (`TASK_DOCUMENTS_BUDGET_BYTES` is still `1024 * 1024`, so a single 1.5 MB image is already omitted).

- [ ] **Step 3: Write the implementation**

Replace the import at the top of `apps/worker/src/task-documents.ts` (line 1):

```ts
// BEFORE
import type { TaskContextItem } from "@agentfactory/core";
```

```ts
// AFTER
import { TASK_CONTEXT_MIME_CONFIG } from "@agentfactory/core";
import type { TaskContextItem } from "@agentfactory/core";
```

Replace the budget constant and its comment (originally lines 9-13):

```ts
// BEFORE
// Total across every document on the task, not per document — the upload route already caps a
// single file at 2 MB (apps/web's tasks/[taskId]/context-items/route.ts:18). This bounds what a
// task with many attachments can push through a tar into the container: 1 MB is ~150x the 6.7 KB
// document that motivated this work, and still an order of magnitude under one maximal upload.
export const TASK_DOCUMENTS_BUDGET_BYTES = 1024 * 1024;
```

```ts
// AFTER
// Total across every document (and now image) on the task, not per file — the upload route
// already caps a single file at 2 MB (apps/web's tasks/[taskId]/context-items/route.ts:18). Raised
// from the original 1 MB (sized for a 6.7 KB motivating text document, before images existed) to
// 8 MB so a task carrying a couple of 2 MB images alongside its text documents doesn't get them
// silently omitted here even though they uploaded successfully.
export const TASK_DOCUMENTS_BUDGET_BYTES = 8 * 1024 * 1024;
```

Replace the `files` declaration (originally line 91):

```ts
// BEFORE
    const files: Record<string, string> = {};
```

```ts
// AFTER
    const files: Record<string, string | Buffer> = {};
```

Replace the decode line inside the loop (originally lines 110-116):

```ts
// BEFORE
      const name = deduplicate(sanitiseDocumentName(item.title, item.id), taken);
      taken.add(name);
      // Uploads are constrained to text/markdown and text/plain by the upload route, so decoding
      // as UTF-8 is safe here and writeFiles takes strings.
      files[`${TASK_DOCUMENT_DIR}/${name}`] = new TextDecoder().decode(bytes);
      written.push(`${TASK_DOCUMENT_DIR}/${name}`);
      usedBytes += item.sizeBytes;
```

```ts
// AFTER
      const name = deduplicate(sanitiseDocumentName(item.title, item.id), taken);
      taken.add(name);
      // TASK_CONTEXT_MIME_CONFIG says which mimes are safely UTF-8-decodable; anything else
      // (images today) is written as raw bytes so binary content isn't corrupted. An unconfigured
      // mime defaults to the text path, matching this function's behavior before images existed.
      const mimeConfig = TASK_CONTEXT_MIME_CONFIG[item.mime];
      files[`${TASK_DOCUMENT_DIR}/${name}`] =
        mimeConfig?.decodeAsText === false ? Buffer.from(bytes) : new TextDecoder().decode(bytes);
      written.push(`${TASK_DOCUMENT_DIR}/${name}`);
      usedBytes += item.sizeBytes;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit apps/worker/src/__tests__/task-documents.test.ts`
Expected: PASS (all tests, including the 3 new ones — this also re-confirms the pre-existing `TASK_DOCUMENT_EXCLUDE_PATTERN against real git` suite still passes unaffected, since it doesn't touch `materialiseTaskDocuments` at all)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/task-documents.ts apps/worker/src/__tests__/task-documents.test.ts
git commit -m "$(cat <<'EOF'
feat(worker): materialize images as raw bytes, raise sandbox budget to 8 MB

materialiseTaskDocuments now decodes as UTF-8 only when
TASK_CONTEXT_MIME_CONFIG says a mime is text; anything else (images)
is written as a raw Buffer via the now-binary-capable writeFiles.
TASK_DOCUMENTS_BUDGET_BYTES rises from 1 MB to 8 MB so legitimately-
uploaded images aren't silently omitted from the sandbox.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Generalize the attached-files prompt wording

**Files:**
- Modify: `apps/worker/src/prompt-composition.ts:90-97`
- Test: `apps/worker/src/__tests__/prompt-composition.test.ts`

**Interfaces:**
- Consumes: nothing new — `formatEnvironmentForPrompt`'s signature and `SandboxEnvironment.taskDocuments` shape are unchanged; this is a copy-only change to text that already covers whatever `materialiseTaskDocuments` (Task 8) wrote, images included.

- [ ] **Step 1: Write the failing test**

Add to `apps/worker/src/__tests__/prompt-composition.test.ts`, near the existing `"names the attached documents and says they are complete"` test:

```ts
  it("frames attached files as things to open, so an image reads correctly alongside a document", () => {
    const result = formatEnvironmentForPrompt({
      workspacePath: "/workspace",
      taskDocuments: { written: [".agentfactory/context/screenshot.png"], omitted: [] },
    });

    expect(result).toContain("open them directly");
    expect(result).toContain("view an image, read a text document");
    // The two claims the existing test suite already locks in must still hold with the new wording.
    expect(result).toContain("complete files");
    expect(result).toContain("rather than searching");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit apps/worker/src/__tests__/prompt-composition.test.ts`
Expected: FAIL — the current copy says "read them directly" and never mentions viewing an image.

- [ ] **Step 3: Write the implementation**

Replace the `written.length > 0` block in `formatEnvironmentForPrompt` (originally lines 90-97 of `apps/worker/src/prompt-composition.ts`):

```ts
// BEFORE
    if (written.length > 0) {
      lines.push(
        `- The documents attached to this task are already in your checkout at ` +
          `\`${env.workspacePath}/${TASK_DOCUMENT_DIR}\`: ${written
            .map((path) => `\`${path}\``)
            .join(", ")}. These are the complete files — read them directly rather than searching ` +
          "for them, and prefer them over any excerpt of the same document quoted elsewhere in " +
          "this prompt. They are untracked and excluded from git; leave them out of your commits.",
      );
    }
```

```ts
// AFTER
    if (written.length > 0) {
      lines.push(
        `- The files attached to this task are already in your checkout at ` +
          `\`${env.workspacePath}/${TASK_DOCUMENT_DIR}\`: ${written
            .map((path) => `\`${path}\``)
            .join(", ")}. These are the complete files — open them directly rather than searching ` +
          "for them (view an image, read a text document), and prefer them over any excerpt of the " +
          "same document quoted elsewhere in this prompt. They are untracked and excluded from " +
          "git; leave them out of your commits.",
      );
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit apps/worker/src/__tests__/prompt-composition.test.ts`
Expected: PASS (all tests — the new one, and every pre-existing assertion on `"complete files"`, `"rather than searching"`, and `"excluded from git"`, which the new wording still contains verbatim)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/prompt-composition.ts apps/worker/src/__tests__/prompt-composition.test.ts
git commit -m "$(cat <<'EOF'
feat(worker): generalize the attached-files prompt wording for images

Reworded from "documents ... read them directly" to "files ... open
them directly (view an image, read a text document)" so the same
sentence reads correctly whether materialiseTaskDocuments wrote a
markdown file or a screenshot into the sandbox.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] Run the full unit suite: `pnpm test:unit`
- [ ] Run the db-integration suite: `pnpm test:db`
- [ ] Run typecheck across the whole workspace: `pnpm typecheck`
- [ ] Run lint across the whole workspace: `pnpm lint`
- [ ] Manually verify in a dev environment: open a task's Context tab, upload a `.png`, confirm it reaches "Indexed" with a thumbnail, and confirm (via `apps/worker`'s logs or a real run) that the image lands in `.agentfactory/context` inside the sandbox and the agent's prompt mentions it.
