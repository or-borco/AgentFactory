import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import type { AgentMemoryEntry, MemorySource } from "@agentfactory/core";
import { db } from "../client";
import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret } from "../crypto";
import { agentMemoryEntries } from "../schema";

function toEntry(row: typeof agentMemoryEntries.$inferSelect): AgentMemoryEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    orgId: row.orgId,
    source: row.source as MemorySource,
    weight: row.weight,
    createdAt: row.createdAt.toISOString(),
    lastReinforcedAt: row.lastReinforcedAt.toISOString(),
    lastSourceRunId: row.lastSourceRunId ?? undefined,
    lastSourceSessionId: row.lastSourceSessionId ?? undefined,
  };
}

export interface SimilarMemoryMatch {
  id: number;
  weight: number;
}

// Mirrors searchTeamContextChunks' transaction/relaxed_order shape (context-chunks.ts) — the same
// "HNSW yields ~ef_search candidates globally, then filters" failure mode applies here even at
// this table's much smaller per-agent scale, so the fix is reused rather than skipped as
// premature. Top-1 only: memory dedup only ever needs to know about the single closest entry.
export async function findSimilarMemoryEntry(
  orgId: number,
  agentId: number,
  embedding: number[],
  floor: number,
): Promise<SimilarMemoryMatch | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.iterative_scan = 'relaxed_order'`);

    const distance = cosineDistance(agentMemoryEntries.embedding, embedding);
    const [row] = await tx
      .select({
        id: agentMemoryEntries.id,
        weight: agentMemoryEntries.weight,
        distance: sql<number>`${distance}`.as("distance"),
      })
      .from(agentMemoryEntries)
      .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.agentId, agentId)))
      .orderBy(distance)
      .limit(1);

    if (!row) return undefined;
    const score = 1 - Number(row.distance);
    return score >= floor ? { id: row.id, weight: row.weight } : undefined;
  });
}

export interface NewMemoryEntry {
  orgId: number;
  agentId: number;
  source: MemorySource;
  content: string;
  embedding: number[];
  embeddingModel: string;
  lastSourceRunId?: number;
  lastSourceSessionId?: number;
}

export async function insertMemoryEntry(row: NewMemoryEntry): Promise<number> {
  const [inserted] = await db
    .insert(agentMemoryEntries)
    .values({
      orgId: row.orgId,
      agentId: row.agentId,
      source: row.source,
      ciphertext: encryptSecret({ content: row.content }),
      keyVersion: CURRENT_KEY_VERSION,
      embedding: row.embedding,
      embeddingModel: row.embeddingModel,
      lastSourceRunId: row.lastSourceRunId,
      lastSourceSessionId: row.lastSourceSessionId,
    })
    .returning({ id: agentMemoryEntries.id });
  return inserted.id;
}

export interface MemoryProvenance {
  runId?: number;
  sessionId?: number;
}

export async function reinforceMemoryEntry(id: number, provenance: MemoryProvenance): Promise<void> {
  await db
    .update(agentMemoryEntries)
    .set({
      weight: sql`${agentMemoryEntries.weight} + 1`,
      lastReinforcedAt: new Date(),
      ...(provenance.runId !== undefined ? { lastSourceRunId: provenance.runId } : {}),
      ...(provenance.sessionId !== undefined ? { lastSourceSessionId: provenance.sessionId } : {}),
    })
    .where(eq(agentMemoryEntries.id, id));
}

// Ordered by weight desc then recency desc — the same priority buildAgentMemorySegment
// (prompt-composition.ts) fills the prompt budget in. Throws (does not swallow) on a decrypt
// failure, matching readConnectionSecret's documented contract: a key mismatch or tamper must
// surface as an error, not be indistinguishable from "no such row".
export async function readAgentMemoryEntries(
  orgId: number,
  agentId: number,
): Promise<Array<AgentMemoryEntry & { content: string }>> {
  const rows = await db
    .select()
    .from(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.agentId, agentId)))
    .orderBy(desc(agentMemoryEntries.weight), desc(agentMemoryEntries.lastReinforcedAt));
  return rows.map((row) => ({ ...toEntry(row), content: decryptSecret(row.ciphertext).content }));
}

// Re-encrypts content only — does NOT recompute the embedding. See this task's own note in the
// plan for why: packages/db has no embedder (that lives in apps/worker), and introducing a new
// queue/job for this rarely-used edit path isn't worth the complexity. A future dedup match
// against the pre-edit embedding is a minor quality tradeoff, not a correctness break.
export async function updateMemoryEntryContent(orgId: number, id: number, content: string): Promise<void> {
  await db
    .update(agentMemoryEntries)
    .set({ ciphertext: encryptSecret({ content }), keyVersion: CURRENT_KEY_VERSION })
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.id, id)));
}

/** Org-scoped delete. A wrong-org or missing id is a no-op, matching connection-secrets' delete semantics. */
export async function deleteMemoryEntry(orgId: number, id: number): Promise<void> {
  await db
    .delete(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.id, id)));
}
