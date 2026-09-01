import { describe, expect, it, vi } from "vitest";

const pipelineMock = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => pipelineMock(...args),
}));

const { EMBEDDING_DIMENSIONS, getEmbedder } = await import("../embedder");

describe("embedder dimension guard", () => {
  it("throws when the model returns a vector of the wrong width", async () => {
    // A 128-wide vector would otherwise reach insertTeamContextChunks and come back as an opaque
    // "expected 384 dimensions, not 128" from Postgres, one layer too late to name the cause.
    pipelineMock.mockResolvedValue(
      vi.fn(async (texts: string[]) => ({ tolist: () => texts.map(() => new Array(128).fill(0.1)) })),
    );

    await expect(getEmbedder().embedDocuments(["one"])).rejects.toThrow(
      `Embedder returned 128 dimensions, expected ${EMBEDDING_DIMENSIONS}`,
    );
  });
});
