import type { ContextItemStatus } from "@agentfactory/core";
import type { TranslationKey } from "@/lib/i18n/paths";

// Keyed on the status union, so adding a fifth ContextItemStatus is a compile error here
// rather than a blank badge in the documents panel.
export const CONTEXT_ITEM_STATUS_LABEL_KEYS: Record<ContextItemStatus, TranslationKey> = {
  pending: "teamsV2.documentStatus.pending",
  indexing: "teamsV2.documentStatus.indexing",
  indexed: "teamsV2.documentStatus.indexed",
  failed: "teamsV2.documentStatus.failed",
};

// Badge has three tones and no danger tone (packages/shared/src/Badge.tsx). "failed" takes
// "warning" rather than the component growing a fourth tone for this one call site — the
// message rendered underneath the row is what actually explains the state.
export const CONTEXT_ITEM_STATUS_TONES: Record<ContextItemStatus, "neutral" | "success" | "warning"> = {
  pending: "neutral",
  indexing: "neutral",
  indexed: "success",
  failed: "warning",
};

// The two states the ingest worker can still move an item out of on its own; everything else
// is where it stops. This is the same set the worker's stalled-redelivery guard admits
// (apps/worker/src/context-ingest.ts), stated once on each side of the wire.
const NON_TERMINAL: ReadonlySet<ContextItemStatus> = new Set<ContextItemStatus>(["pending", "indexing"]);

export function isTerminalContextItemStatus(status: ContextItemStatus): boolean {
  return !NON_TERMINAL.has(status);
}

// Whether the documents list is still worth polling. Ingestion has no push channel back to the
// browser, so the panel refetches — but only while something can still change, and never for
// an empty list.
export function hasPendingIngest(items: { status: ContextItemStatus }[]): boolean {
  return items.some((item) => !isTerminalContextItemStatus(item.status));
}
