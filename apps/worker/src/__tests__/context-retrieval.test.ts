import { describe, expect, it, vi } from "vitest";
import type { ContextChunkMatch } from "@agentfactory/db";

// context-retrieval reaches for the db package (whose client throws at import without
// DATABASE_URL) and the embedder (which pulls in onnxruntime and would download a model on a
// fresh clone). The unit project has neither a database nor a network policy, and
// .husky/pre-push runs it, so both are mocked at import — same pattern as repo-map.test.ts.
const countIndexedContextItemsMock = vi.fn();
const searchContextChunksMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  countIndexedContextItems: (...args: unknown[]) => countIndexedContextItemsMock(...args),
  searchContextChunks: (...args: unknown[]) => searchContextChunksMock(...args),
}));

const getEmbedderMock = vi.fn();
vi.mock("../embedder", () => ({
  getEmbedder: () => getEmbedderMock(),
}));

const {
  RETRIEVAL_BUDGET_BYTES,
  RETRIEVAL_K,
  SIMILARITY_FLOOR,
  buildRetrievalQuery,
  selectWithinBudget,
} = await import("../context-retrieval");

const match = (over: Partial<ContextChunkMatch> & { id: number; text: string }): ContextChunkMatch => ({
  itemId: 1,
  itemTitle: "Engineering handbook",
  chunkIdx: 0,
  score: 0.9,
  ...over,
});

describe("retrieval constants", () => {
  it("pins K, the similarity floor, and the byte budget", () => {
    expect(RETRIEVAL_K).toBe(12);
    expect(SIMILARITY_FLOOR).toBe(0.35);
    expect(RETRIEVAL_BUDGET_BYTES).toBe(8192);
  });
});

describe("buildRetrievalQuery", () => {
  it("joins title, description, and the triggering message with a blank line, in that order", () => {
    expect(buildRetrievalQuery("Fix the login flow", "Sessions expire early", "Any runbook for this?")).toBe(
      "Fix the login flow\n\nSessions expire early\n\nAny runbook for this?",
    );
  });

  it("drops absent and whitespace-only parts rather than emitting empty blocks", () => {
    expect(buildRetrievalQuery("Fix the login flow", "   ", undefined)).toBe("Fix the login flow");
    expect(buildRetrievalQuery(undefined, undefined, "Any runbook for this?")).toBe("Any runbook for this?");
  });

  it("returns an empty string when there is nothing to search with", () => {
    expect(buildRetrievalQuery(undefined, "", "  \n ")).toBe("");
  });
});

describe("selectWithinBudget", () => {
  it("keeps chunks in order and stops before the one that would exceed the budget", () => {
    const a = match({ id: 1, text: "a".repeat(40) });
    const b = match({ id: 2, text: "b".repeat(40) });
    const c = match({ id: 3, text: "c".repeat(40) });

    expect(selectWithinBudget([a, b, c], 100)).toEqual([a, b]);
  });

  // capSharedContext (packages/db/src/repositories/teams.ts:13-17) measures bytes and then
  // slices characters, which is how a 40 000-character string of 3-byte codepoints survives a
  // 65 536-byte cap unchanged and then violates the CHECK. Not repeated here.
  it("measures bytes, not characters: 100 three-byte codepoints is 300 bytes", () => {
    const multibyte = match({ id: 1, text: "文".repeat(100) });
    expect(multibyte.text).toHaveLength(100);
    expect(new TextEncoder().encode(multibyte.text).length).toBe(300);

    expect(selectWithinBudget([multibyte], 250)).toEqual([]);
    expect(selectWithinBudget([multibyte], 300)).toEqual([multibyte]);
  });

  it("drops whole chunks and never returns a sliced one", () => {
    const a = match({ id: 1, text: "a".repeat(60) });
    const b = match({ id: 2, text: "b".repeat(60) });

    const kept = selectWithinBudget([a, b], 100);

    expect(kept).toHaveLength(1);
    expect(kept[0].text).toBe(a.text);
  });

  it("returns nothing when the first chunk alone exceeds the budget", () => {
    expect(selectWithinBudget([match({ id: 1, text: "a".repeat(200) })], 100)).toEqual([]);
  });

  it("stops rather than skipping ahead, so the kept chunks stay a contiguous prefix", () => {
    const big = match({ id: 1, text: "a".repeat(90) });
    const small = match({ id: 2, text: "b".repeat(5) });

    expect(selectWithinBudget([big, small], 50)).toEqual([]);
  });

  it("returns an empty array for no matches", () => {
    expect(selectWithinBudget([], 8192)).toEqual([]);
  });
});
