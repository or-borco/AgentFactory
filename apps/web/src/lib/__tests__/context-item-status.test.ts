import { describe, expect, it } from "vitest";
import {
  CONTEXT_ITEM_STATUS_LABEL_KEYS,
  CONTEXT_ITEM_STATUS_TONES,
  hasPendingIngest,
  isTerminalContextItemStatus,
} from "../context-item-status";

describe("context item status", () => {
  it("maps every status to a label key and a badge tone", () => {
    expect(CONTEXT_ITEM_STATUS_LABEL_KEYS).toEqual({
      pending: "teamsV2.documentStatus.pending",
      indexing: "teamsV2.documentStatus.indexing",
      indexed: "teamsV2.documentStatus.indexed",
      failed: "teamsV2.documentStatus.failed",
    });
    expect(CONTEXT_ITEM_STATUS_TONES).toEqual({
      pending: "neutral",
      indexing: "neutral",
      indexed: "success",
      failed: "warning",
    });
  });

  it("treats only indexed and failed as terminal", () => {
    expect(isTerminalContextItemStatus("pending")).toBe(false);
    expect(isTerminalContextItemStatus("indexing")).toBe(false);
    expect(isTerminalContextItemStatus("indexed")).toBe(true);
    expect(isTerminalContextItemStatus("failed")).toBe(true);
  });

  it("reports pending ingest while any item can still move", () => {
    expect(hasPendingIngest([{ status: "indexed" }, { status: "failed" }])).toBe(false);
    expect(hasPendingIngest([{ status: "indexed" }, { status: "indexing" }])).toBe(true);
    expect(hasPendingIngest([{ status: "pending" }])).toBe(true);
  });

  // An empty list is the state a team sits in before its first upload. Polling it forever
  // would put a request every three seconds behind an empty panel, on every open tab.
  it("reports no pending ingest for an empty list", () => {
    expect(hasPendingIngest([])).toBe(false);
  });
});
