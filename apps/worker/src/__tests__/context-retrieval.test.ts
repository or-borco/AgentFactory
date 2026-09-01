import { describe, expect, it, vi } from "vitest";
import type { ContextChunkMatch } from "@agentfactory/db";

// context-retrieval reaches for the db package (whose client throws at import without
// DATABASE_URL) and the embedder (which pulls in onnxruntime and would download a model on a
// fresh clone). The unit project has neither a database nor a network policy, and
// .husky/pre-push runs it, so both are mocked at import — same pattern as repo-map.test.ts.
const countIndexedTeamContextItemsMock = vi.fn();
const searchTeamContextChunksMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  countIndexedTeamContextItems: (...args: unknown[]) => countIndexedTeamContextItemsMock(...args),
  searchTeamContextChunks: (...args: unknown[]) => searchTeamContextChunksMock(...args),
}));

const getEmbedderMock = vi.fn();
vi.mock("../embedder", () => ({
  getEmbedder: () => getEmbedderMock(),
}));

const {
  RETRIEVAL_BUDGET_BYTES,
  RETRIEVAL_K,
  RETRIEVED_CONTEXT_FOOTER,
  RETRIEVED_CONTEXT_HEADING,
  SIMILARITY_FLOOR,
  buildRetrievalQuery,
  retrieveContext,
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
    expect(SIMILARITY_FLOOR).toBe(0.6);
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

function fakeEmbedder(vector = [0.1, 0.2, 0.3]) {
  return {
    modelId: "Xenova/bge-small-en-v1.5",
    dimensions: 384,
    embedQuery: vi.fn().mockResolvedValue(vector),
    embedDocuments: vi.fn(),
  };
}

describe("retrieveContext", () => {
  it("wraps the kept chunks as untrusted reference material and ranks them", async () => {
    const embedder = fakeEmbedder();
    const result = await retrieveContext(7, "how do we handle incidents?", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(2),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 11, itemId: 3, itemTitle: "Runbooks", chunkIdx: 4, text: "Page the on-call.", score: 0.81 }),
        match({ id: 12, itemId: 3, itemTitle: "Runbooks", chunkIdx: 5, text: "Open an incident channel.", score: 0.62 }),
      ]),
      embedder,
    });

    expect(result.omittedReason).toBeUndefined();
    expect(result.text).toBe(
      `${RETRIEVED_CONTEXT_HEADING}\n\n[Excerpt 0] Page the on-call.\n\n[Excerpt 1] Open an incident channel.\n\n${RETRIEVED_CONTEXT_FOOTER}\n\n---\n\n`,
    );
    expect(result.retrievals).toEqual([
      { itemId: 3, itemTitle: "Runbooks", chunkIdx: 4, rank: 1, score: 0.81 },
      { itemId: 3, itemTitle: "Runbooks", chunkIdx: 5, rank: 2, score: 0.62 },
    ]);
    expect(embedder.embedQuery).toHaveBeenCalledWith("how do we handle incidents?");
  });

  // The eval judge's report_eval tool asks for a per-excerpt chunkIdx it has no real signal
  // for otherwise; the "[Excerpt N]" marker is the ground truth eval-judge.ts counts against
  // to detect a judge that silently drops or under-reports excerpts (see
  // countInjectedExcerpts in eval-judge.ts).
  it("numbers each kept excerpt so the judge has a real ordinal to report, not a guess", async () => {
    const result = await retrieveContext(7, "how do we handle incidents?", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(2),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 11, itemId: 3, itemTitle: "Runbooks", chunkIdx: 4, text: "Page the on-call.", score: 0.81 }),
        match({ id: 12, itemId: 3, itemTitle: "Runbooks", chunkIdx: 5, text: "Open an incident channel.", score: 0.62 }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result.text).toContain("[Excerpt 0] Page the on-call.");
    expect(result.text).toContain("[Excerpt 1] Open an incident channel.");
  });

  it("asks the index for exactly RETRIEVAL_K candidates", async () => {
    const searchTeamContextChunks = vi.fn().mockResolvedValue([]);
    await retrieveContext(7, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      searchTeamContextChunks,
      embedder: fakeEmbedder([0.5]),
    });

    expect(searchTeamContextChunks).toHaveBeenCalledWith(7, [0.5], RETRIEVAL_K);
  });

  // The embedder is a several-hundred-megabyte lazy init; a team with nothing indexed must
  // never pay for it.
  it("omits with no_indexed_documents without touching the embedder or the index", async () => {
    const embedder = fakeEmbedder();
    const searchTeamContextChunks = vi.fn();

    const result = await retrieveContext(7, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(0),
      searchTeamContextChunks,
      embedder,
    });

    expect(result).toEqual({ text: "", retrievals: [], omittedReason: "no_indexed_documents" });
    expect(embedder.embedQuery).not.toHaveBeenCalled();
    expect(searchTeamContextChunks).not.toHaveBeenCalled();
  });

  it("omits with no_relevant_chunks when everything is below the similarity floor", async () => {
    const result = await retrieveContext(7, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(3),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, text: "Unrelated paragraph.", score: SIMILARITY_FLOOR - 0.01 }),
        match({ id: 2, text: "Also unrelated.", score: 0.02 }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result).toEqual({ text: "", retrievals: [], omittedReason: "no_relevant_chunks" });
  });

  it("keeps a chunk sitting exactly on the floor", async () => {
    const result = await retrieveContext(7, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, text: "Borderline.", score: SIMILARITY_FLOOR }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result.omittedReason).toBeUndefined();
    expect(result.retrievals).toHaveLength(1);
  });

  it("applies the byte budget, dropping the chunks that do not fit", async () => {
    const result = await retrieveContext(7, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, chunkIdx: 0, text: "a".repeat(RETRIEVAL_BUDGET_BYTES - 10), score: 0.9 }),
        match({ id: 2, chunkIdx: 1, text: "b".repeat(100), score: 0.8 }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result.retrievals.map((r) => r.chunkIdx)).toEqual([0]);
    expect(result.text).not.toContain("b".repeat(100));
  });

  it("omits with no_relevant_chunks for an empty query, without touching anything", async () => {
    const countIndexedTeamContextItems = vi.fn();
    const result = await retrieveContext(7, "   ", {
      countIndexedTeamContextItems,
      searchTeamContextChunks: vi.fn(),
      embedder: fakeEmbedder(),
    });

    expect(result).toEqual({ text: "", retrievals: [], omittedReason: "no_relevant_chunks" });
    expect(countIndexedTeamContextItems).not.toHaveBeenCalled();
  });

  // ARCHITECTURE.md §4's no-retry rule exists because a run has side effects; the flip side is
  // that a run must never DIE for a missing convenience. Retrieval degrades, exactly as
  // ensureRepoMap returns "".
  it("never throws into the run: a failing search becomes retrieval_failed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await retrieveContext(7, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(2),
      searchTeamContextChunks: vi.fn().mockRejectedValue(new Error("extension \"vector\" is not available")),
      embedder: fakeEmbedder(),
    });

    expect(result).toEqual({ text: "", retrievals: [], omittedReason: "retrieval_failed" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("degrades the same way when the embedder itself fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const embedder = fakeEmbedder();
    embedder.embedQuery.mockRejectedValue(new Error("model load failed"));

    const result = await retrieveContext(7, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(2),
      searchTeamContextChunks: vi.fn(),
      embedder,
    });

    expect(result.omittedReason).toBe("retrieval_failed");
    consoleError.mockRestore();
  });
});
