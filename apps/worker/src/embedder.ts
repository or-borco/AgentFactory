// The embedding port. One model in dev and production — a pgvector column is typed with a fixed
// width and the HNSW index needs that width, so two environments would mean two schemas and a
// dev setup that never exercises the production retrieval path. A vendor swap is an explicit
// re-embed migration, which is cheap because the original files are kept in content_blobs.
export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_MODEL_ID = "Xenova/bge-small-en-v1.5";
export const EMBEDDING_DIMENSIONS = 384;
// bge-* is asymmetric: the instruction prefixes the QUERY only, never the documents. Getting
// this backwards costs real retrieval quality and is invisible without evals, which is why it
// lives in the port (embedQuery vs embedDocuments) rather than at the call sites.
export const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

// The transformers.js pipeline, narrowed to the one call shape used here — the real type is a
// callable class with a much wider surface, and a narrow local type keeps the test double honest.
type FeatureExtractor = (
  texts: string[],
  options: { pooling: "cls"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

class LocalEmbedder implements Embedder {
  readonly modelId = EMBEDDING_MODEL_ID;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  // Cached promise, not a cached value: two concurrent embed calls must not each start a load.
  private extractor?: Promise<FeatureExtractor>;

  // Dynamic import, deliberately. `.husky/pre-push` runs `pnpm test:unit` with no network policy
  // of its own, so a module-scope pipeline() would make the first push after a clone download a
  // model from the Hugging Face hub; `tsx watch` would reload it on every save.
  private load(): Promise<FeatureExtractor> {
    this.extractor ??= import("@huggingface/transformers").then(
      ({ pipeline }) =>
        pipeline("feature-extraction", EMBEDDING_MODEL_ID) as unknown as Promise<FeatureExtractor>,
    );
    return this.extractor;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    // CLS pooling with L2 normalisation is what bge-* was trained with. Normalised vectors also
    // make pgvector's cosine distance a plain dot product, which is what PR 5's `1 - distance`
    // similarity assumes.
    const output = await extractor(texts, { pooling: "cls", normalize: true });
    const vectors = output.tolist();
    const width = vectors[0]?.length ?? 0;
    if (width !== EMBEDDING_DIMENSIONS) {
      // Named here rather than left to Postgres: context_chunks.embedding is vector(384) and a
      // mismatch would surface as an opaque insert failure one layer too late to explain.
      throw new Error(`Embedder returned ${width} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
    }
    return vectors;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([QUERY_INSTRUCTION + text]);
    return vector;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }
}

let embedder: Embedder | undefined;

// Lazy singleton cached at module scope. Constructing it is free — the model is loaded by the
// first embed call, not by this function — so importers may call it at module scope safely.
// PR 4's IngestDeps and PR 5's RetrievalDeps both default their `embedder` field to this.
export function getEmbedder(): Embedder {
  embedder ??= new LocalEmbedder();
  return embedder;
}
