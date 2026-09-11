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
