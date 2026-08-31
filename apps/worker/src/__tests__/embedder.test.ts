import { beforeEach, describe, expect, it, vi } from "vitest";

// The real module is never loaded: pipeline() downloads ~130MB from the Hugging Face hub on
// first call, and this suite is what .husky/pre-push runs. Same shape as repo-map.test.ts's
// @agentfactory/queue mock — the dependency is replaced at import, not stubbed after the fact.
const pipelineMock = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

const { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, QUERY_INSTRUCTION, getEmbedder } = await import("../embedder");

function fakeExtractor(dimensions = EMBEDDING_DIMENSIONS) {
  return vi.fn(async (texts: string[]) => ({
    tolist: () => texts.map((_, i) => Array.from({ length: dimensions }, () => 0.1 * (i + 1))),
  }));
}

describe("getEmbedder", () => {
  // Shared across the tests below the first embed call: the singleton caches its pipeline
  // promise for this whole file's lifetime, so only the first test that triggers a load actually
  // invokes pipelineMock — every later test reuses that same cached extractor, not whatever
  // pipelineMock is newly configured to return. Capturing the reference here (rather than each
  // test creating its own and expecting it to be called) reflects that.
  let extractor: ReturnType<typeof fakeExtractor>;

  beforeEach(() => {
    pipelineMock.mockReset();
  });

  // Declaration order matters: this asserts the state before any embed call in this file has
  // forced the lazy load.
  it("does not load the model when the embedder is constructed", () => {
    const embedder = getEmbedder();

    expect(embedder.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(pipelineMock).not.toHaveBeenCalled();
  });

  it("returns the same instance every call", () => {
    expect(getEmbedder()).toBe(getEmbedder());
  });

  it("prefixes a query with the bge instruction and returns one vector", async () => {
    extractor = fakeExtractor();
    pipelineMock.mockResolvedValue(extractor);

    const vector = await getEmbedder().embedQuery("How do we roll back a deploy?");

    expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", EMBEDDING_MODEL_ID);
    expect(extractor).toHaveBeenCalledWith(
      [`${QUERY_INSTRUCTION}How do we roll back a deploy?`],
      { pooling: "cls", normalize: true },
    );
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("embeds documents bare — the instruction prefix is query-only", async () => {
    // No new mockResolvedValue here: the model was already loaded by the previous test, and the
    // singleton reuses that cached extractor rather than asking pipelineMock again.
    const vectors = await getEmbedder().embedDocuments(["Handbook › Deploys\n\nRun pnpm build.", "second"]);

    expect(extractor).toHaveBeenCalledWith(
      ["Handbook › Deploys\n\nRun pnpm build.", "second"],
      { pooling: "cls", normalize: true },
    );
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("loads the pipeline once and reuses it across calls", async () => {
    pipelineMock.mockResolvedValue(fakeExtractor());
    const embedder = getEmbedder();

    await embedder.embedDocuments(["one"]);
    await embedder.embedDocuments(["two"]);
    await embedder.embedQuery("three");

    expect(pipelineMock).not.toHaveBeenCalled(); // already loaded by an earlier test in this file
  });

  it("skips the model entirely for an empty batch", async () => {
    const extractor = fakeExtractor();
    pipelineMock.mockResolvedValue(extractor);

    await expect(getEmbedder().embedDocuments([])).resolves.toEqual([]);

    expect(extractor).not.toHaveBeenCalled();
  });
});
