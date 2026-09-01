import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskContextItem } from "@agentfactory/core";
import type { BlobStore } from "@agentfactory/storage";
import type { Chunk } from "../chunker";
import type { Embedder } from "../embedder";

// @agentfactory/db opens a Postgres client in its module body; the unit project has no
// database. Every export the handler binds as a default dep has to exist on the mock, even
// though every test injects a stub over it. Mirrors context-ingest.test.ts.
vi.mock("@agentfactory/db", () => ({
  getTaskContextItem: vi.fn(),
  markTaskContextItemIndexing: vi.fn(),
  markTaskContextItemIndexed: vi.fn(),
  markTaskContextItemFailed: vi.fn(),
  deleteTaskChunksForItem: vi.fn(),
  insertTaskContextChunks: vi.fn(),
  // ingestTeamContextItem's own defaults live in the same module; the import at the bottom of
  // this file pulls in context-ingest.ts as a whole, which binds these at module load time too.
  getTeamContextItem: vi.fn(),
  markTeamContextItemIndexing: vi.fn(),
  markTeamContextItemIndexed: vi.fn(),
  markTeamContextItemFailed: vi.fn(),
  deleteTeamChunksForItem: vi.fn(),
  insertTeamContextChunks: vi.fn(),
}));

// Same reason repo-map.test.ts mocks it: packages/queue/src/index.ts throws at import when
// REDIS_URL is unset, and this file runs in the pre-push suite.
vi.mock("@agentfactory/queue", () => ({}));

// Both of these throw rather than returning a stub: the handler resolving either one instead
// of the injected dependency is the failure this test exists to catch — getEmbedder() would
// pull ~130MB of model weights from the Hugging Face hub on the first push after a clone.
vi.mock("@agentfactory/storage", () => ({
  createBlobStore: () => {
    throw new Error("createBlobStore must not be called when a blobStore is injected");
  },
}));
vi.mock("../embedder", () => ({
  getEmbedder: () => {
    throw new Error("getEmbedder must not be called when an embedder is injected");
  },
}));

// The chunker is pure and has its own unit tests; mocked here so each test states the exact
// chunk count it needs instead of reverse-engineering one out of a fixture document.
const chunkDocumentMock = vi.fn();
vi.mock("../chunker", () => ({ chunkDocument: (...args: unknown[]) => chunkDocumentMock(...args) }));

const { EMBED_BATCH_SIZE, ingestTaskContextItem } = await import("../context-ingest");

const SHA = "b".repeat(64);

function makeItem(overrides: Partial<TaskContextItem> = {}): TaskContextItem {
  return {
    id: 5,
    taskId: 4,
    orgId: 2,
    title: "Migration plan",
    sizeBytes: 42,
    sha256: SHA,
    mime: "text/markdown",
    source: "upload",
    status: "pending",
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function chunk(idx: number): Chunk {
  return { chunkIdx: idx, text: `Migration plan › Section ${idx}\n\nBody ${idx}` };
}

function makeDeps(item: TaskContextItem | undefined, bytes?: Uint8Array) {
  // Not a default parameter: `makeDeps(item, undefined)` must simulate a missing blob, but a
  // default value on `bytes` would substitute the fixture text for an explicit `undefined`
  // argument too (JS default-parameter semantics trigger on the value, not on arity), silently
  // defeating the one test that needs `blobStore.get` to resolve to nothing. `arguments.length`
  // tells the two call shapes apart. Mirrors context-ingest.test.ts's makeDeps.
  const resolvedBytes = arguments.length >= 2 ? bytes : new TextEncoder().encode("# Plan\n\nBody");
  const embedder: Embedder = {
    modelId: "Xenova/bge-small-en-v1.5",
    dimensions: 384,
    embedQuery: vi.fn(),
    embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [0.3, 0.4])),
  };
  const blobStore: BlobStore = {
    put: vi.fn(),
    get: vi.fn(async () => resolvedBytes),
  };
  return {
    getTaskContextItem: vi.fn(async () => item),
    markTaskContextItemIndexing: vi.fn(async () => {}),
    markTaskContextItemIndexed: vi.fn(async () => {}),
    markTaskContextItemFailed: vi.fn(async (_id: number, _error: string) => {}),
    deleteTaskChunksForItem: vi.fn(async () => {}),
    insertTaskContextChunks: vi.fn(async () => {}),
    blobStore,
    embedder,
  };
}

beforeEach(() => {
  chunkDocumentMock.mockReset();
  chunkDocumentMock.mockReturnValue([chunk(0), chunk(1)]);
});

describe("ingestTaskContextItem", () => {
  it("does nothing when the item is gone", async () => {
    const deps = makeDeps(undefined);

    await ingestTaskContextItem(5, deps);

    expect(deps.markTaskContextItemIndexing).not.toHaveBeenCalled();
    expect(deps.markTaskContextItemFailed).not.toHaveBeenCalled();
  });

  // BullMQ re-delivers a stalled job after a worker crash. Re-running an item that already
  // reached a terminal state would walk an "indexed" row back through "indexing", and would
  // clobber a "failed" row's message with a second attempt nobody asked for.
  it("refuses a redelivered job for an item that already settled", async () => {
    for (const status of ["indexed", "failed"] as const) {
      const deps = makeDeps(makeItem({ status }));

      await ingestTaskContextItem(5, deps);

      expect(deps.markTaskContextItemIndexing).not.toHaveBeenCalled();
      expect(deps.blobStore.get).not.toHaveBeenCalled();
      expect(deps.insertTaskContextChunks).not.toHaveBeenCalled();
    }
  });

  // "indexing" is an accepted entry state on purpose: a crash mid-job leaves the row there,
  // and the redelivery is how it recovers. This is the whole reason the handler is idempotent.
  it("accepts a redelivered job for an item left at indexing", async () => {
    const deps = makeDeps(makeItem({ status: "indexing" }));

    await ingestTaskContextItem(5, deps);

    expect(deps.markTaskContextItemIndexed).toHaveBeenCalledWith(5);
  });

  it("reads the blob, chunks it, and inserts embedded chunks", async () => {
    const deps = makeDeps(makeItem());

    await ingestTaskContextItem(5, deps);

    expect(deps.blobStore.get).toHaveBeenCalledWith(2, SHA);
    expect(chunkDocumentMock).toHaveBeenCalledWith("Migration plan", "# Plan\n\nBody");
    expect(deps.insertTaskContextChunks).toHaveBeenCalledWith([
      { itemId: 5, taskId: 4, chunkIdx: 0, text: chunk(0).text, embedding: [0.3, 0.4], embeddingModel: "Xenova/bge-small-en-v1.5" },
      { itemId: 5, taskId: 4, chunkIdx: 1, text: chunk(1).text, embedding: [0.3, 0.4], embeddingModel: "Xenova/bge-small-en-v1.5" },
    ]);
    expect(deps.markTaskContextItemIndexed).toHaveBeenCalledWith(5);
  });

  it("deletes the item's existing chunks before inserting new ones", async () => {
    const deps = makeDeps(makeItem());

    await ingestTaskContextItem(5, deps);

    expect(deps.deleteTaskChunksForItem).toHaveBeenCalledWith(5);
    expect(deps.deleteTaskChunksForItem.mock.invocationCallOrder[0]).toBeLessThan(
      deps.insertTaskContextChunks.mock.invocationCallOrder[0],
    );
  });

  // The ingest worker shares a process with the run worker at concurrency 1. One document
  // embedded in a single call would hold the event loop for the whole document; the await
  // between batches is what lets a queued run job get picked up in between.
  it("embeds in batches of EMBED_BATCH_SIZE", async () => {
    const chunks = Array.from({ length: EMBED_BATCH_SIZE + 1 }, (_, i) => chunk(i));
    chunkDocumentMock.mockReturnValue(chunks);
    const deps = makeDeps(makeItem());

    await ingestTaskContextItem(5, deps);

    const calls = (deps.embedder.embedDocuments as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toHaveLength(EMBED_BATCH_SIZE);
    expect(calls[1][0]).toHaveLength(1);
    expect(deps.insertTaskContextChunks).toHaveBeenCalledTimes(2);
  });

  it("marks the item failed when the blob is missing, without throwing", async () => {
    const deps = makeDeps(makeItem(), undefined);

    await expect(ingestTaskContextItem(5, deps)).resolves.toBeUndefined();

    expect(deps.markTaskContextItemFailed).toHaveBeenCalledWith(5, `Blob ${SHA} is missing from the blob store`);
    expect(deps.markTaskContextItemIndexed).not.toHaveBeenCalled();
  });

  it("marks the item failed when the mime is not one we extract", async () => {
    const deps = makeDeps(makeItem({ mime: "application/pdf" }));

    await ingestTaskContextItem(5, deps);

    expect(deps.markTaskContextItemFailed).toHaveBeenCalledTimes(1);
    expect(deps.markTaskContextItemFailed.mock.calls[0][0]).toBe(5);
    expect(deps.markTaskContextItemFailed.mock.calls[0][1]).toContain("application/pdf");
    expect(deps.insertTaskContextChunks).not.toHaveBeenCalled();
  });
});
