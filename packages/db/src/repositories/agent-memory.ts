import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import type { AgentMemoryEntry, MemorySource } from "@agentfactory/core";
import { db } from "../client";
import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret } from "../crypto";
import { agentMemoryEntries, agentMemoryWrites } from "../schema";

function toEntry(row: typeof agentMemoryEntries.$inferSelect): AgentMemoryEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    orgId: row.orgId,
    source: row.source as MemorySource,
    weight: row.weight,
    createdAt: row.createdAt.toISOString(),
    lastReinforcedAt: row.lastReinforcedAt.toISOString(),
  };
}

export interface SimilarMemoryMatch {
  id: number;
  weight: number;
}

// Mirrors searchTeamContextChunks' transaction/relaxed_order shape (context-chunks.ts). The same
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
}

export interface MemoryWriteInput {
  source: MemorySource;
  lesson: string;
  reason?: string;
  sessionId?: number;
  runId?: number;
}

function encryptWrite(lesson: string, reason?: string): string {
  return encryptSecret(reason ? { lesson, reason } : { lesson });
}

export async function insertMemoryEntryWithWrite(entry: NewMemoryEntry, write: MemoryWriteInput): Promise<number> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(agentMemoryEntries)
      .values({
        orgId: entry.orgId,
        agentId: entry.agentId,
        source: entry.source,
        ciphertext: encryptSecret({ content: entry.content }),
        keyVersion: CURRENT_KEY_VERSION,
        embedding: entry.embedding,
        embeddingModel: entry.embeddingModel,
      })
      .returning({ id: agentMemoryEntries.id });
    await tx.insert(agentMemoryWrites).values({
      orgId: entry.orgId,
      agentId: entry.agentId,
      entryId: inserted.id,
      kind: "insert",
      source: write.source,
      ciphertext: encryptWrite(write.lesson, write.reason),
      keyVersion: CURRENT_KEY_VERSION,
      sessionId: write.sessionId,
      runId: write.runId,
    });
    return inserted.id;
  });
}

export async function reinforceMemoryEntryWithWrite(
  orgId: number,
  agentId: number,
  entryId: number,
  write: MemoryWriteInput,
): Promise<{ reinforced: boolean; duplicate: boolean }> {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: agentMemoryEntries.id })
      .from(agentMemoryEntries)
      .where(
        and(
          eq(agentMemoryEntries.orgId, orgId),
          eq(agentMemoryEntries.agentId, agentId),
          eq(agentMemoryEntries.id, entryId),
        ),
      )
      .for("update");
    if (!owned) return { reinforced: false, duplicate: false };

    const [logged] = await tx
      .insert(agentMemoryWrites)
      .values({
        orgId,
        agentId,
        entryId,
        kind: "reinforce",
        source: write.source,
        ciphertext: encryptWrite(write.lesson, write.reason),
        keyVersion: CURRENT_KEY_VERSION,
        sessionId: write.sessionId,
        runId: write.runId,
      })
      .onConflictDoNothing()
      .returning({ id: agentMemoryWrites.id });
    if (!logged) return { reinforced: false, duplicate: true };

    await tx
      .update(agentMemoryEntries)
      .set({ weight: sql`${agentMemoryEntries.weight} + 1`, lastReinforcedAt: new Date() })
      .where(eq(agentMemoryEntries.id, entryId));
    return { reinforced: true, duplicate: false };
  });
}

// Ordered by weight desc then recency desc, the same priority buildAgentMemorySegment
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

export async function updateMemoryEntryContent(orgId: number, id: number, content: string, userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(agentMemoryEntries)
      .set({ ciphertext: encryptSecret({ content }), keyVersion: CURRENT_KEY_VERSION })
      .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.id, id)))
      .returning({ agentId: agentMemoryEntries.agentId });
    if (!updated) return;
    await tx.insert(agentMemoryWrites).values({
      orgId,
      agentId: updated.agentId,
      entryId: id,
      kind: "edit",
      ciphertext: encryptWrite(content),
      keyVersion: CURRENT_KEY_VERSION,
      userId,
    });
  });
}

/** Org-scoped delete. A wrong-org or missing id is a no-op, matching connection-secrets' delete semantics. */
export async function deleteMemoryEntry(orgId: number, id: number): Promise<void> {
  await db
    .delete(agentMemoryEntries)
    .where(and(eq(agentMemoryEntries.orgId, orgId), eq(agentMemoryEntries.id, id)));
}
