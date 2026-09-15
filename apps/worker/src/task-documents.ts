import { TASK_CONTEXT_MIME_CONFIG } from "@agentfactory/core";
import type { TaskContextItem } from "@agentfactory/core";
import { listTaskContextItemsForOrg } from "@agentfactory/db";
import { createBlobStore, type BlobStore } from "@agentfactory/storage";
import type { SandboxProvider } from "./sandbox/types";
import { TASK_DOCUMENT_DIR } from "./task-document-paths";

export { TASK_DOCUMENT_DIR, TASK_DOCUMENT_EXCLUDE_PATTERN } from "./task-document-paths";

// Total across every document (and now image) on the task, not per file — the upload route
// already caps a single file at 2 MB (apps/web's tasks/[taskId]/context-items/route.ts:18). Raised
// from the original 1 MB (sized for a 6.7 KB motivating text document, before images existed) to
// 8 MB so a task carrying a couple of 2 MB images alongside its text documents doesn't get them
// silently omitted here even though they uploaded successfully.
export const TASK_DOCUMENTS_BUDGET_BYTES = 8 * 1024 * 1024;

export interface MaterialisedTaskDocuments {
  // Paths relative to /workspace, in the order they were written.
  written: string[];
  // Document titles that did not make it, so the prompt can say so rather than letting the agent
  // read the directory as the complete set.
  omitted: string[];
}

const EMPTY: MaterialisedTaskDocuments = { written: [], omitted: [] };

// Narrow function types rather than typeof imports, so unit tests stub each seam with a plain
// vi.fn() — same shape as RetrievalDeps (context-retrieval.ts:94-108).
export interface TaskDocumentDeps {
  listTaskContextItemsForOrg: (taskId: number, orgId: number) => Promise<TaskContextItem[]>;
  blobStore: BlobStore;
}

// createBlobStore() reads env on every call, so it is resolved lazily and only when the caller
// did not inject one — a test with a stub store never touches the real module.
function resolveDeps(overrides?: Partial<TaskDocumentDeps>): TaskDocumentDeps {
  return {
    listTaskContextItemsForOrg,
    blobStore: overrides?.blobStore ?? createBlobStore(),
    ...overrides,
  };
}

// `title` is whatever the uploader named the file, so it reaches here as untrusted text that is
// about to become a path. Everything outside a conservative allowlist collapses to a dash, path
// separators included, and a leading dot is stripped so a document cannot land as a hidden file
// or climb out of the directory as "..".
export function sanitiseDocumentName(title: string, fallbackId: number): string {
  const base = title.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
  return cleaned || `document-${fallbackId}`;
}

// Two uploads can legitimately share a filename — the items table is unique on (task_id, sha256),
// not on title. Suffix before the extension so "spec.md" and "spec.md" become "spec.md" and
// "spec-2.md" rather than a name git and the agent would both read as extensionless.
function deduplicate(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Writes the task's indexed documents into the sandbox before the turn, so the agent can read the
// whole of what a human attached instead of only the excerpts that won a similarity ranking.
//
// Never fails a run. Every path returns a result and logs its own error, exactly as ensureRepoMap
// degrades to "" and retrieveContext degrades to an omitted segment — a document that cannot be
// written leaves the run behaving as it did before this existed.
export async function materialiseTaskDocuments(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  taskId: number,
  orgId: number,
  deps?: Partial<TaskDocumentDeps>,
): Promise<MaterialisedTaskDocuments> {
  try {
    const resolved = resolveDeps(deps);
    const items = await resolved.listTaskContextItemsForOrg(taskId, orgId);
    // Only indexed items have bytes worth writing. A document still ingesting has no guarantee
    // its bytes are complete or its extraction succeeded; a failed one has nothing usable at all
    // (see the omitted-titles pass below, which still names it rather than letting it vanish).
    const indexed = items.filter((item) => item.status === "indexed");

    const files: Record<string, string | Buffer> = {};
    const written: string[] = [];
    const omitted: string[] = [];
    const taken = new Set<string>();
    let usedBytes = 0;

    // A failed item has nothing to write, but unlike "pending" it is a terminal state the agent
    // should be told about rather than let vanish with no trace — same reasoning as the
    // budget-overflow branch below, just a different reason for having nothing usable. Not scoped
    // to any particular source: today only Jira-sourced attachments realistically fail ingestion
    // (an unsupported mime type), but this filter has no business knowing that.
    for (const item of items) {
      if (item.status === "failed") omitted.push(item.title);
    }

    if (indexed.length === 0) return { written: [], omitted };

    for (const item of indexed) {
      // `continue`, not `break`: one oversized attachment should not hide every smaller one
      // behind it. Same reasoning as the task-side budget selection in context-retrieval.ts.
      if (usedBytes + item.sizeBytes > TASK_DOCUMENTS_BUDGET_BYTES) {
        omitted.push(item.title);
        continue;
      }
      const bytes = await resolved.blobStore.get(orgId, item.sha256);
      if (!bytes) {
        console.error(`Task document ${item.id} (${item.title}) has no blob under ${item.sha256}`);
        omitted.push(item.title);
        continue;
      }
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
    }

    if (written.length === 0) return { written: [], omitted };

    // Created explicitly rather than relying on the archive extraction to materialise parent
    // directories for us — this is writeFiles' first production caller, and a missing directory
    // would fail silently as "the agent didn't find the files".
    await execToCompletion(sandboxProvider, sandboxId, ["mkdir", "-p", `/workspace/${TASK_DOCUMENT_DIR}`]);
    await sandboxProvider.writeFiles(sandboxId, files);
    return { written, omitted };
  } catch (err) {
    console.error(`Failed to materialise task documents for task ${taskId}:`, err);
    return EMPTY;
  }
}

async function execToCompletion(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  cmd: string[],
): Promise<void> {
  for await (const _chunk of sandboxProvider.exec(sandboxId, cmd)) {
    // Drained rather than collected: the caller only needs the command to have finished.
  }
}
