import { describe, expect, it, vi } from "vitest";
import type { ContextChunkMatch, TaskContextChunkMatch } from "@agentfactory/db";

// context-retrieval reaches for the db package (whose client throws at import without
// DATABASE_URL) and the embedder (which pulls in onnxruntime and would download a model on a
// fresh clone). The unit project has neither a database nor a network policy, and
// .husky/pre-push runs it, so both are mocked at import — same pattern as repo-map.test.ts.
const countIndexedTeamContextItemsMock = vi.fn();
const countIndexedTaskContextItemsMock = vi.fn();
const searchTeamContextChunksMock = vi.fn();
const searchTaskContextChunksMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  countIndexedTeamContextItems: (...args: unknown[]) => countIndexedTeamContextItemsMock(...args),
  countIndexedTaskContextItems: (...args: unknown[]) => countIndexedTaskContextItemsMock(...args),
  searchTeamContextChunks: (...args: unknown[]) => searchTeamContextChunksMock(...args),
  searchTaskContextChunks: (...args: unknown[]) => searchTaskContextChunksMock(...args),
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
  TASK_RESERVED_BUDGET_BYTES,
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

const taskMatch = (
  over: Partial<TaskContextChunkMatch> & { id: number; text: string },
): TaskContextChunkMatch => ({
  itemId: 1,
  itemTitle: "Attached brief",
  chunkIdx: 0,
  score: 0.9,
  ...over,
});

// No-op stand-ins for the deps not exercised by a given test — resolveDeps merges these over the
// real module, so a test only needs to override what it actually asserts on.
function noopDeps() {
  return {
    countIndexedTeamContextItems: vi.fn().mockResolvedValue(0),
    countIndexedTaskContextItems: vi.fn().mockResolvedValue(0),
    searchTeamContextChunks: vi.fn().mockResolvedValue([]),
    searchTaskContextChunks: vi.fn().mockResolvedValue([]),
  };
}

describe("retrieval constants", () => {
  it("pins K, the similarity floor, and the byte budgets", () => {
    expect(RETRIEVAL_K).toBe(12);
    expect(SIMILARITY_FLOOR).toBe(0.6);
    expect(RETRIEVAL_BUDGET_BYTES).toBe(16384);
    expect(TASK_RESERVED_BUDGET_BYTES).toBe(8192);
  });

  // The floor is taken OUT of the ceiling, not added alongside it — team chunks get whatever the
  // task slice leaves behind. A floor at or above the ceiling would starve team retrieval to
  // nothing on any task with documents, which is the failure mode that made these two constants
  // impossible to reason about separately.
  it("leaves team retrieval real room once the task slice is fully spent", () => {
    expect(TASK_RESERVED_BUDGET_BYTES).toBeLessThan(RETRIEVAL_BUDGET_BYTES);
    expect(RETRIEVAL_BUDGET_BYTES - TASK_RESERVED_BUDGET_BYTES).toBeGreaterThanOrEqual(8192);
  });

  // The pair of documents task T-070 actually needed: the attached spec (6,736 B chunked) and the
  // engineering handbook its description named by name (~1,450 B). At the old 8 KB ceiling these
  // did not both fit, before a single other team chunk was considered.
  it("fits the two documents T-070 needed", () => {
    expect(6736 + 1450).toBeLessThanOrEqual(RETRIEVAL_BUDGET_BYTES);
    expect(6736).toBeLessThanOrEqual(TASK_RESERVED_BUDGET_BYTES);
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

describe("selectWithinBudget — skipOversized", () => {
  const chunk = (id: number, bytes: number) => ({ id, text: "x".repeat(bytes) });

  // Run 27: 1,504 bytes kept of 2,048, and a 388-byte chunk that fit in the remaining 544 was
  // dropped because the loop stopped at the first overflow.
  it("keeps a later chunk that fits after skipping one that does not", () => {
    const kept = selectWithinBudget([chunk(1, 400), chunk(2, 900), chunk(3, 80)], 500, true);
    expect(kept.map((c) => c.id)).toEqual([1, 3]);
  });

  it("still stops at the first overflow by default, preserving the contiguous prefix", () => {
    const kept = selectWithinBudget([chunk(1, 400), chunk(2, 900), chunk(3, 80)], 500);
    expect(kept.map((c) => c.id)).toEqual([1]);
  });

  it("never exceeds the budget in either mode", () => {
    for (const skip of [true, false]) {
      const kept = selectWithinBudget([chunk(1, 400), chunk(2, 900), chunk(3, 80)], 500, skip);
      const used = kept.reduce((sum, c) => sum + c.text.length, 0);
      expect(used).toBeLessThanOrEqual(500);
    }
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

describe("retrieveContext — team-only (unchanged behavior)", () => {
  it("wraps the kept chunks as untrusted reference material and ranks them", async () => {
    const embedder = fakeEmbedder();
    const result = await retrieveContext(
      { teamId: 7 },
      "how do we handle incidents?",
      {
        ...noopDeps(),
        countIndexedTeamContextItems: vi.fn().mockResolvedValue(2),
        searchTeamContextChunks: vi.fn().mockResolvedValue([
          match({ id: 11, itemId: 3, itemTitle: "Runbooks", chunkIdx: 4, text: "Page the on-call.", score: 0.81 }),
          match({ id: 12, itemId: 3, itemTitle: "Runbooks", chunkIdx: 5, text: "Open an incident channel.", score: 0.62 }),
        ]),
        embedder,
      },
    );

    expect(result.omittedReason).toBeUndefined();
    expect(result.text).toBe(
      `${RETRIEVED_CONTEXT_HEADING}\n\n[Excerpt 0] Page the on-call.\n\n[Excerpt 1] Open an incident channel.\n\n${RETRIEVED_CONTEXT_FOOTER}\n\n---\n\n`,
    );
    expect(result.retrievals).toEqual([
      { itemId: 3, itemKind: "team", itemTitle: "Runbooks", chunkIdx: 4, rank: 1, score: 0.81 },
      { itemId: 3, itemKind: "team", itemTitle: "Runbooks", chunkIdx: 5, rank: 2, score: 0.62 },
    ]);
    expect(embedder.embedQuery).toHaveBeenCalledWith("how do we handle incidents?");
  });

  // The eval judge's report_eval tool asks for a per-excerpt chunkIdx it has no real signal
  // for otherwise; the "[Excerpt N]" marker is the ground truth eval-judge.ts counts against
  // to detect a judge that silently drops or under-reports excerpts (see
  // countInjectedExcerpts in eval-judge.ts).
  it("numbers each kept excerpt so the judge has a real ordinal to report, not a guess", async () => {
    const result = await retrieveContext({ teamId: 7 }, "how do we handle incidents?", {
      ...noopDeps(),
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
    await retrieveContext({ teamId: 7 }, "anything", {
      ...noopDeps(),
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

    const result = await retrieveContext({ teamId: 7 }, "anything", {
      ...noopDeps(),
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(0),
      searchTeamContextChunks,
      embedder,
    });

    expect(result).toEqual({ text: "", retrievals: [], omittedReason: "no_indexed_documents" });
    expect(embedder.embedQuery).not.toHaveBeenCalled();
    expect(searchTeamContextChunks).not.toHaveBeenCalled();
  });

  it("omits with no_relevant_chunks when everything is below the similarity floor", async () => {
    const result = await retrieveContext({ teamId: 7 }, "anything", {
      ...noopDeps(),
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(3),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, text: "Unrelated paragraph.", score: SIMILARITY_FLOOR - 0.01 }),
        match({ id: 2, text: "Also unrelated.", score: 0.02 }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result).toEqual({ text: "", retrievals: [], omittedReason: "no_relevant_chunks" });
  });

  it("keeps a team chunk sitting exactly on the floor, but a chunk below it is still excluded", async () => {
    const result = await retrieveContext({ teamId: 7 }, "anything", {
      ...noopDeps(),
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, chunkIdx: 0, text: "Borderline.", score: SIMILARITY_FLOOR }),
        match({ id: 2, chunkIdx: 1, text: "Off-topic.", score: SIMILARITY_FLOOR - 0.001 }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result.omittedReason).toBeUndefined();
    expect(result.retrievals).toHaveLength(1);
    expect(result.retrievals[0].chunkIdx).toBe(0);
  });

  it("applies the full RETRIEVAL_BUDGET_BYTES budget when there is no task, dropping chunks that do not fit", async () => {
    const result = await retrieveContext({ teamId: 7 }, "anything", {
      ...noopDeps(),
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
    const result = await retrieveContext({ teamId: 7 }, "   ", {
      ...noopDeps(),
      countIndexedTeamContextItems,
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

    const result = await retrieveContext({ teamId: 7 }, "anything", {
      ...noopDeps(),
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

    const result = await retrieveContext({ teamId: 7 }, "anything", {
      ...noopDeps(),
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(2),
      embedder,
    });

    expect(result.omittedReason).toBe("retrieval_failed");
    consoleError.mockRestore();
  });
});

// The change these tests exist for: similarity ranking should choose AMONG competing material,
// not WITHIN one document a human attached. On run 27 it chose that document's Rollout, Non-goals
// and Testing-tail sections over every normative one, because the task description's procedural
// half embedded closer to them.
describe("retrieveContext — task document ordering and coverage", () => {
  // Builds a document as N chunks of `chunkBytes` each, scored so that document order and score
  // order deliberately disagree: the LAST chunk scores highest, exactly as on run 27.
  function document(itemId: number, itemTitle: string, chunks: number, chunkBytes: number) {
    return Array.from({ length: chunks }, (_, i) =>
      taskMatch({
        id: itemId * 100 + i,
        itemId,
        itemTitle,
        chunkIdx: i,
        text: "x".repeat(chunkBytes),
        score: 0.5 + i * 0.01,
      }),
    );
  }

  it("injects a document that fits whole in chunk_idx order, not score order", async () => {
    const result = await retrieveContext({ taskId: 70 }, "add a retry layer", {
      ...noopDeps(),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTaskContextChunks: vi.fn().mockResolvedValue(document(9, "spec.md", 5, 200)),
      embedder: fakeEmbedder(),
    });

    expect(result.retrievals.map((r) => r.chunkIdx)).toEqual([0, 1, 2, 3, 4]);
    expect(result.retrievals.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  // The T-070 regression, to scale: 9 chunks totalling 6,736 bytes. Under the old 2,048-byte
  // reserved slice this delivered 3 chunks and 22.3% of the document.
  it("injects all of a T-070-sized attached document", async () => {
    const chunks = [749, 853, 975, 1143, 388, 1124, 561, 510, 433].map((bytes, i) =>
      taskMatch({
        id: i,
        itemId: 9,
        itemTitle: "transcriber-retry-spec.md",
        chunkIdx: i,
        text: "x".repeat(bytes),
        // The real run's scores: the tail outranked every normative section.
        score: i >= 6 ? 0.8 + i * 0.01 : 0.5,
      }),
    );

    const result = await retrieveContext({ taskId: 70 }, "add a retry layer", {
      ...noopDeps(),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTaskContextChunks: vi.fn().mockResolvedValue(chunks),
      embedder: fakeEmbedder(),
    });

    expect(result.retrievals).toHaveLength(9);
    expect(result.retrievals.map((r) => r.chunkIdx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // The normative sections — the retry policy and the error classifiers — are chunks 1 and 2,
    // and both were excluded before this change.
    expect(result.retrievals.some((r) => r.chunkIdx === 1)).toBe(true);
    expect(result.retrievals.some((r) => r.chunkIdx === 2)).toBe(true);
  });

  it("gives the most relevant document first claim when two cannot both fit whole", async () => {
    const lowScoring = document(1, "background.md", 10, 600);
    const highScoring = document(2, "spec.md", 5, 600).map((m) => ({ ...m, score: m.score + 0.4 }));

    const result = await retrieveContext({ taskId: 70 }, "add a retry layer", {
      ...noopDeps(),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(2),
      searchTaskContextChunks: vi.fn().mockResolvedValue([...lowScoring, ...highScoring]),
      embedder: fakeEmbedder(),
    });

    // spec.md (3,000 B) fits whole and leads; background.md (6,000 B) does not fit in what is
    // left, so its chunks fall through to the score-ranked path.
    expect(result.retrievals.slice(0, 5).map((r) => r.itemTitle)).toEqual(Array(5).fill("spec.md"));
    expect(result.retrievals.slice(0, 5).map((r) => r.chunkIdx)).toEqual([0, 1, 2, 3, 4]);
  });

  // A document too large to fit whole still gets ranked chunk-by-chunk, exactly as before.
  it("falls back to score order within a document that cannot fit whole", async () => {
    const result = await retrieveContext({ taskId: 70 }, "add a retry layer", {
      ...noopDeps(),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTaskContextChunks: vi.fn().mockResolvedValue(document(9, "huge.md", 12, 1000)),
      embedder: fakeEmbedder(),
    });

    const idxs = result.retrievals.map((r) => r.chunkIdx);
    expect(idxs.length).toBeLessThan(12);
    // Highest-scoring chunk is the last one, so score order puts it first.
    expect(idxs[0]).toBe(11);
  });

  it("keeps rank contiguous from 1, which the eval judge counts against", async () => {
    const result = await retrieveContext({ taskId: 70 }, "add a retry layer", {
      ...noopDeps(),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTaskContextChunks: vi.fn().mockResolvedValue(document(9, "spec.md", 6, 300)),
      embedder: fakeEmbedder(),
    });

    expect(result.retrievals.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    for (let i = 0; i < result.retrievals.length; i += 1) {
      expect(result.text).toContain(`[Excerpt ${i}] `);
    }
  });
});

describe("retrieveContext — task-only", () => {
  it("keeps a task chunk scored well below the similarity floor, unlike a team chunk", async () => {
    const result = await retrieveContext({ taskId: 42 }, "anything", {
      ...noopDeps(),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTaskContextChunks: vi.fn().mockResolvedValue([
        taskMatch({ id: 1, itemId: 9, itemTitle: "Attached brief", chunkIdx: 0, text: "Below-floor but attached.", score: 0.1 }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result.omittedReason).toBeUndefined();
    expect(result.retrievals).toEqual([
      { itemId: 9, itemKind: "task", itemTitle: "Attached brief", chunkIdx: 0, rank: 1, score: 0.1 },
    ]);
    expect(result.text).toContain("Below-floor but attached.");
  });

  it("asks the task index for exactly RETRIEVAL_K candidates and never touches the team index", async () => {
    const searchTaskContextChunks = vi.fn().mockResolvedValue([]);
    const searchTeamContextChunks = vi.fn();
    await retrieveContext({ taskId: 42 }, "anything", {
      ...noopDeps(),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTaskContextChunks,
      searchTeamContextChunks,
      embedder: fakeEmbedder([0.5]),
    });

    expect(searchTaskContextChunks).toHaveBeenCalledWith(42, [0.5], RETRIEVAL_K);
    expect(searchTeamContextChunks).not.toHaveBeenCalled();
  });

  it("keeps only the highest-scoring task chunks once the task's own documents exceed the reserved budget", async () => {
    const big = taskMatch({ id: 1, itemId: 9, chunkIdx: 0, text: "a".repeat(TASK_RESERVED_BUDGET_BYTES - 10), score: 0.2 });
    const bigger = taskMatch({ id: 2, itemId: 9, chunkIdx: 1, text: "b".repeat(TASK_RESERVED_BUDGET_BYTES - 10), score: 0.9 });

    const result = await retrieveContext({ taskId: 42 }, "anything", {
      ...noopDeps(),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      // Returned in arbitrary order — retrieveContext must sort by score itself before budgeting.
      searchTaskContextChunks: vi.fn().mockResolvedValue([big, bigger]),
      embedder: fakeEmbedder(),
    });

    expect(result.retrievals).toHaveLength(1);
    expect(result.retrievals[0].chunkIdx).toBe(1);
  });
});

describe("retrieveContext — combined team + task", () => {
  it("includes a below-floor task chunk while still excluding a below-floor team chunk", async () => {
    const result = await retrieveContext({ teamId: 7, taskId: 42 }, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, itemId: 3, itemTitle: "Handbook", chunkIdx: 0, text: "Below floor, team-sourced.", score: SIMILARITY_FLOOR - 0.2 }),
      ]),
      searchTaskContextChunks: vi.fn().mockResolvedValue([
        taskMatch({ id: 2, itemId: 9, itemTitle: "Attached brief", chunkIdx: 0, text: "Below floor, task-sourced.", score: 0.05 }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result.retrievals).toEqual([
      { itemId: 9, itemKind: "task", itemTitle: "Attached brief", chunkIdx: 0, rank: 1, score: 0.05 },
    ]);
    expect(result.text).toContain("Below floor, task-sourced.");
    expect(result.text).not.toContain("Below floor, team-sourced.");
  });

  it("presents task excerpts before team excerpts, task chunks first in rank order", async () => {
    const result = await retrieveContext({ teamId: 7, taskId: 42 }, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, itemId: 3, itemTitle: "Handbook", chunkIdx: 0, text: "Team excerpt.", score: 0.9 }),
      ]),
      searchTaskContextChunks: vi.fn().mockResolvedValue([
        taskMatch({ id: 2, itemId: 9, itemTitle: "Attached brief", chunkIdx: 0, text: "Task excerpt.", score: 0.3 }),
      ]),
      embedder: fakeEmbedder(),
    });

    expect(result.retrievals.map((r) => r.itemKind)).toEqual(["task", "team"]);
    expect(result.text.indexOf("Task excerpt.")).toBeLessThan(result.text.indexOf("Team excerpt."));
  });

  it("rolls unused task budget over to team retrieval instead of wasting it", async () => {
    // The task has a single small document, using only a sliver of TASK_RESERVED_BUDGET_BYTES —
    // the remaining ~16 KB (not just the 8 KB team would get if the split were static) must still
    // be available to team chunks.
    const teamText = "x".repeat(RETRIEVAL_BUDGET_BYTES - 100);
    const result = await retrieveContext({ teamId: 7, taskId: 42 }, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(1),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, itemId: 3, itemTitle: "Handbook", chunkIdx: 0, text: teamText, score: 0.9 }),
      ]),
      searchTaskContextChunks: vi.fn().mockResolvedValue([
        taskMatch({ id: 2, itemId: 9, itemTitle: "Attached brief", chunkIdx: 0, text: "small", score: 0.3 }),
      ]),
      embedder: fakeEmbedder(),
    });

    // Would be dropped under a fixed 8 KB team allotment (16384 - 8192 = 8192 < teamText's length)
    // but survives because the task's unused reserved budget rolled over.
    expect(result.retrievals.map((r) => r.itemKind)).toEqual(["task", "team"]);
    expect(result.text).toContain(teamText);
  });

  it("a task with no documents leaves the full budget for team retrieval, matching team-only behavior", async () => {
    const teamText = "x".repeat(RETRIEVAL_BUDGET_BYTES - 100);
    const result = await retrieveContext({ teamId: 7, taskId: 42 }, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(0),
      searchTeamContextChunks: vi.fn().mockResolvedValue([
        match({ id: 1, itemId: 3, itemTitle: "Handbook", chunkIdx: 0, text: teamText, score: 0.9 }),
      ]),
      searchTaskContextChunks: vi.fn().mockResolvedValue([]),
      embedder: fakeEmbedder(),
    });

    expect(result.retrievals).toEqual([
      { itemId: 3, itemKind: "team", itemTitle: "Handbook", chunkIdx: 0, rank: 1, score: 0.9 },
    ]);
  });

  it("omits with no_indexed_documents only when neither side has anything indexed", async () => {
    const result = await retrieveContext({ teamId: 7, taskId: 42 }, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(0),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(0),
      searchTeamContextChunks: vi.fn(),
      searchTaskContextChunks: vi.fn(),
      embedder: fakeEmbedder(),
    });

    expect(result).toEqual({ text: "", retrievals: [], omittedReason: "no_indexed_documents" });
  });

  it("still searches when only one side has anything indexed", async () => {
    const searchTaskContextChunks = vi.fn().mockResolvedValue([]);
    await retrieveContext({ teamId: 7, taskId: 42 }, "anything", {
      countIndexedTeamContextItems: vi.fn().mockResolvedValue(1),
      countIndexedTaskContextItems: vi.fn().mockResolvedValue(0),
      searchTeamContextChunks: vi.fn().mockResolvedValue([]),
      searchTaskContextChunks,
      embedder: fakeEmbedder(),
    });

    // Both sides are still searched once indexed count is nonzero on either — the search calls
    // happen unconditionally when the id is present, regardless of that id's own indexed count.
    expect(searchTaskContextChunks).toHaveBeenCalled();
  });
});
