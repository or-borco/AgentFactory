import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { agentMemoryEntries, agents } from "../../schema.js";
import {
  deleteMemoryEntry,
  findSimilarMemoryEntry,
  insertMemoryEntryWithWrite,
  readAgentMemoryEntries,
  reinforceMemoryEntryWithWrite,
  updateMemoryEntryContent,
} from "../../repositories/agent-memory.js";
import { insertAgent, insertOrg, insertSession, insertUser } from "../fixtures.js";
import { createRun } from "../../repositories/runs.js";
import { eq } from "drizzle-orm";

const DIMENSIONS = 384;
const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

function planeVector(angleRad: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[0] = Math.cos(angleRad);
  v[1] = Math.sin(angleRad);
  return v;
}

async function setup() {
  const org = await insertOrg();
  const agent = await insertAgent(org.id);
  return { org, agent };
}

function insertEntry(orgId: number, agentId: number, content: string, source: "manual" | "retrospective" = "manual") {
  return insertMemoryEntryWithWrite(
    { orgId, agentId, source, content, embedding: planeVector(0), embeddingModel: EMBEDDING_MODEL },
    { source, lesson: content },
  );
}

describe("agent-memory repository", () => {
  it("round-trips a memory entry's content through insert and decrypt", async () => {
    const { org, agent } = await setup();

    const id = await insertEntry(org.id, agent.id, "Never run migrations directly against production.");

    const entries = await readAgentMemoryEntries(org.id, agent.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id,
      agentId: agent.id,
      orgId: org.id,
      source: "manual",
      weight: 1,
      content: "Never run migrations directly against production.",
    });
  });

  it("finds a similar entry above the floor and returns undefined below it", async () => {
    const { org, agent } = await setup();
    await insertEntry(org.id, agent.id, "Always open a draft PR, never push to main.");

    // A near-identical angle clears a 0.85 floor; cos(0.1 rad) ≈ 0.995.
    const closeMatch = await findSimilarMemoryEntry(org.id, agent.id, planeVector(0.1), 0.85);
    expect(closeMatch).toBeDefined();
    expect(closeMatch?.weight).toBe(1);

    // Orthogonal (π/2 rad) has cosine similarity 0, far below the floor.
    const noMatch = await findSimilarMemoryEntry(org.id, agent.id, planeVector(Math.PI / 2), 0.85);
    expect(noMatch).toBeUndefined();
  });

  it("never matches across agents or orgs", async () => {
    const { org, agent } = await setup();
    const otherOrg = await insertOrg();
    const otherAgent = await insertAgent(org.id);
    await insertEntry(org.id, agent.id, "Lesson for agent A only.");

    await expect(findSimilarMemoryEntry(org.id, otherAgent.id, planeVector(0), 0.85)).resolves.toBeUndefined();
    await expect(findSimilarMemoryEntry(otherOrg.id, agent.id, planeVector(0), 0.85)).resolves.toBeUndefined();
  });

  it("reinforces an existing entry instead of inserting a second row", async () => {
    const { org, agent } = await setup();
    const session = await insertSession(org.id, agent.id);
    const run = await createRun(session.id);
    const id = await insertEntry(org.id, agent.id, "Don't touch migration files directly.");

    await reinforceMemoryEntryWithWrite(org.id, agent.id, id, {
      source: "manual",
      lesson: "Don't touch migration files directly.",
      runId: run.id,
      sessionId: session.id,
    });

    const rows = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.agentId, agent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(2);
    expect(new Date(rows[0].lastReinforcedAt).getTime()).toBeGreaterThan(new Date(rows[0].createdAt).getTime() - 1);
  });

  it("re-encrypts content on update without changing the stored embedding", async () => {
    const { org, agent } = await setup();
    const user = await insertUser();
    const id = await insertEntry(org.id, agent.id, "Original lesson text.");
    const [before] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, id));

    await updateMemoryEntryContent(org.id, id, "Edited lesson text.", user.id);

    const entries = await readAgentMemoryEntries(org.id, agent.id);
    expect(entries[0].content).toBe("Edited lesson text.");
    const [after] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, id));
    expect(after.embedding).toEqual(before.embedding);
  });

  it("does not update content for a wrong-org id (no-op)", async () => {
    const { org, agent } = await setup();
    const otherOrg = await insertOrg();
    const user = await insertUser();
    const id = await insertEntry(org.id, agent.id, "Original.");

    await updateMemoryEntryContent(otherOrg.id, id, "Hijacked.", user.id);

    const entries = await readAgentMemoryEntries(org.id, agent.id);
    expect(entries[0].content).toBe("Original.");
  });

  it("throws (does not swallow) when a stored ciphertext is tampered with", async () => {
    const { org, agent } = await setup();
    const id = await insertEntry(org.id, agent.id, "Tamper me.");
    const [row] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, id));
    const buf = Buffer.from(row.ciphertext, "base64");
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    await db.update(agentMemoryEntries).set({ ciphertext: buf.toString("base64") }).where(eq(agentMemoryEntries.id, id));

    await expect(readAgentMemoryEntries(org.id, agent.id)).rejects.toThrow();
  });

  it("deletes an entry, org-scoped (wrong-org id is a no-op)", async () => {
    const { org, agent } = await setup();
    const otherOrg = await insertOrg();
    const id = await insertEntry(org.id, agent.id, "Delete me.");

    await deleteMemoryEntry(otherOrg.id, id);
    expect(await readAgentMemoryEntries(org.id, agent.id)).toHaveLength(1);

    await deleteMemoryEntry(org.id, id);
    expect(await readAgentMemoryEntries(org.id, agent.id)).toHaveLength(0);
  });

  it("is deleted when its agent is deleted (cascade)", async () => {
    const { org, agent } = await setup();
    await insertEntry(org.id, agent.id, "Cascade me.");

    await db.delete(agents).where(eq(agents.id, agent.id));

    const rows = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.agentId, agent.id));
    expect(rows).toHaveLength(0);
  });
});
