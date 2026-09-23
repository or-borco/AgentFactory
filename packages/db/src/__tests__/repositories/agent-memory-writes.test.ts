import { describe, expect, it } from "vitest";
import "../setup.js";
import { eq } from "drizzle-orm";
import { db } from "../../client.js";
import { decryptSecret } from "../../crypto.js";
import { agentMemoryEntries, agentMemoryWrites, tasks } from "../../schema.js";
import {
  MEMORY_WRITE_HISTORY_LIMIT,
  deleteMemoryEntry,
  insertMemoryEntryWithWrite,
  listMemoryEntryWrites,
  memoryEntryBelongsToAgent,
  reinforceMemoryEntryWithWrite,
  updateMemoryEntryContent,
} from "../../repositories/agent-memory.js";
import { createRun } from "../../repositories/runs.js";
import { insertAgent, insertOrg, insertSession, insertTask, insertUser } from "../fixtures.js";

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
  const session = await insertSession(org.id, agent.id);
  const run = await createRun(session.id);
  const entryId = await insertMemoryEntryWithWrite(
    {
      orgId: org.id,
      agentId: agent.id,
      source: "retrospective",
      content: "Run the tests before opening a PR.",
      embedding: planeVector(0),
      embeddingModel: EMBEDDING_MODEL,
    },
    {
      source: "retrospective",
      lesson: "Run the tests before opening a PR.",
      reason: "The first PR in run 10 failed CI.",
      sessionId: session.id,
      runId: run.id,
    },
  );
  return { org, agent, session, run, entryId };
}

async function writesFor(entryId: number) {
  return db.select().from(agentMemoryWrites).where(eq(agentMemoryWrites.entryId, entryId));
}

async function weightOf(entryId: number) {
  const [row] = await db.select().from(agentMemoryEntries).where(eq(agentMemoryEntries.id, entryId));
  return row.weight;
}

describe("agent memory write log", () => {
  it("inserting an entry appends one encrypted insert row", async () => {
    const { org, agent, session, run, entryId } = await setup();

    const rows = await writesFor(entryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: org.id,
      agentId: agent.id,
      kind: "insert",
      source: "retrospective",
      sessionId: session.id,
      runId: run.id,
      userId: null,
    });
    expect(rows[0].ciphertext).not.toContain("Run the tests");
    expect(decryptSecret(rows[0].ciphertext)).toEqual({
      lesson: "Run the tests before opening a PR.",
      reason: "The first PR in run 10 failed CI.",
    });
  });

  it("omits reason from the ciphertext when none is given", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const entryId = await insertMemoryEntryWithWrite(
      { orgId: org.id, agentId: agent.id, source: "manual", content: "Use pnpm.", embedding: planeVector(0), embeddingModel: EMBEDDING_MODEL },
      { source: "manual", lesson: "Use pnpm." },
    );

    const [row] = await writesFor(entryId);
    expect(decryptSecret(row.ciphertext)).toEqual({ lesson: "Use pnpm." });
  });

  it("reinforcing bumps the weight and appends one reinforce row", async () => {
    const { org, agent, entryId } = await setup();
    const laterSession = await insertSession(org.id, agent.id);

    const result = await reinforceMemoryEntryWithWrite(org.id, agent.id, entryId, {
      source: "retrospective",
      lesson: "Always run the test suite before a PR.",
      reason: "CI failed again.",
      sessionId: laterSession.id,
    });

    expect(result).toEqual({ reinforced: true, duplicate: false });
    expect(await weightOf(entryId)).toBe(2);
    const reinforceRows = (await writesFor(entryId)).filter((r) => r.kind === "reinforce");
    expect(reinforceRows).toHaveLength(1);
    expect(reinforceRows[0].sessionId).toBe(laterSession.id);
    expect(decryptSecret(reinforceRows[0].ciphertext).lesson).toBe("Always run the test suite before a PR.");
  });

  it("a second reinforce from the same session and source is a no-op", async () => {
    const { org, agent, entryId } = await setup();
    const laterSession = await insertSession(org.id, agent.id);
    const write = { source: "retrospective" as const, lesson: "Run tests first.", sessionId: laterSession.id };

    await reinforceMemoryEntryWithWrite(org.id, agent.id, entryId, write);
    const second = await reinforceMemoryEntryWithWrite(org.id, agent.id, entryId, write);

    expect(second).toEqual({ reinforced: false, duplicate: true });
    expect(await weightOf(entryId)).toBe(2);
    expect((await writesFor(entryId)).filter((r) => r.kind === "reinforce")).toHaveLength(1);
  });

  it("the same session may reinforce once per source", async () => {
    const { org, agent, entryId } = await setup();
    const laterSession = await insertSession(org.id, agent.id);

    await reinforceMemoryEntryWithWrite(org.id, agent.id, entryId, { source: "manual", lesson: "Run tests.", sessionId: laterSession.id });
    await reinforceMemoryEntryWithWrite(org.id, agent.id, entryId, { source: "retrospective", lesson: "Run tests.", sessionId: laterSession.id });

    expect(await weightOf(entryId)).toBe(3);
  });

  it("reinforce with a mismatched org or agent changes nothing", async () => {
    const { org, entryId } = await setup();
    const otherOrg = await insertOrg();
    const otherAgent = await insertAgent(org.id);
    const write = { source: "manual" as const, lesson: "Hijack." };

    expect(await reinforceMemoryEntryWithWrite(otherOrg.id, otherAgent.id, entryId, write)).toEqual({ reinforced: false, duplicate: false });
    expect(await reinforceMemoryEntryWithWrite(org.id, otherAgent.id, entryId, write)).toEqual({ reinforced: false, duplicate: false });

    expect(await weightOf(entryId)).toBe(1);
    expect(await writesFor(entryId)).toHaveLength(1);
  });

  it("an edit appends an edit row with the user and the new text", async () => {
    const { org, entryId } = await setup();
    const user = await insertUser({ name: "Dana" });

    await updateMemoryEntryContent(org.id, entryId, "Run the full test suite before any PR.", user.id);

    const editRows = (await writesFor(entryId)).filter((r) => r.kind === "edit");
    expect(editRows).toHaveLength(1);
    expect(editRows[0]).toMatchObject({ userId: user.id, source: null, sessionId: null, runId: null });
    expect(decryptSecret(editRows[0].ciphertext)).toEqual({ lesson: "Run the full test suite before any PR." });
  });

  it("an edit from the wrong org writes no row", async () => {
    const { entryId } = await setup();
    const otherOrg = await insertOrg();
    const user = await insertUser();

    await updateMemoryEntryContent(otherOrg.id, entryId, "Hijacked.", user.id);

    expect((await writesFor(entryId)).filter((r) => r.kind === "edit")).toHaveLength(0);
  });

  it("deleting an entry keeps its write rows with entry_id null", async () => {
    const { org, agent, entryId } = await setup();

    await deleteMemoryEntry(org.id, entryId);

    const orphaned = await db.select().from(agentMemoryWrites).where(eq(agentMemoryWrites.agentId, agent.id));
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].entryId).toBeNull();
  });
});

describe("listMemoryEntryWrites", () => {
  it("returns decrypted writes newest first", async () => {
    const { org, agent, entryId } = await setup();
    const user = await insertUser({ name: "Dana" });
    const laterSession = await insertSession(org.id, agent.id);
    await reinforceMemoryEntryWithWrite(org.id, agent.id, entryId, { source: "manual", lesson: "Run tests.", sessionId: laterSession.id });
    await updateMemoryEntryContent(org.id, entryId, "Run the full suite.", user.id);

    const items = await listMemoryEntryWrites(org.id, entryId);

    expect(items.map((i) => i.kind)).toEqual(["edit", "reinforce", "insert"]);
    expect(items[0]).toMatchObject({ lesson: "Run the full suite.", editedBy: { id: user.id, name: "Dana" } });
    expect(items[0].source).toBeUndefined();
    expect(items[1]).toMatchObject({ source: "manual", lesson: "Run tests.", session: { id: laterSession.id } });
    expect(items[1].reason).toBeUndefined();
    expect(items[2]).toMatchObject({
      source: "retrospective",
      lesson: "Run the tests before opening a PR.",
      reason: "The first PR in run 10 failed CI.",
    });
  });

  it("attaches the session's task, and falls back to the session when the task is gone", async () => {
    const { org, session, entryId } = await setup();
    const user = await insertUser();
    const task = await insertTask(org.id, user.id, { title: "Add divide()" });
    await db.update(tasks).set({ sessionId: session.id }).where(eq(tasks.id, task.id));

    const [withTask] = await listMemoryEntryWrites(org.id, entryId);
    expect(withTask.task).toEqual({ id: task.id, ref: task.ref, title: "Add divide()" });
    expect(withTask.session).toEqual({ id: session.id });

    await db.delete(tasks).where(eq(tasks.id, task.id));

    const [withoutTask] = await listMemoryEntryWrites(org.id, entryId);
    expect(withoutTask.task).toBeUndefined();
    expect(withoutTask.session).toEqual({ id: session.id });
  });

  it("caps the result at the history limit", async () => {
    const { org, agent, entryId } = await setup();
    for (let i = 0; i < MEMORY_WRITE_HISTORY_LIMIT + 2; i++) {
      const s = await insertSession(org.id, agent.id);
      await reinforceMemoryEntryWithWrite(org.id, agent.id, entryId, { source: "manual", lesson: `Lesson ${i}`, sessionId: s.id });
    }

    const items = await listMemoryEntryWrites(org.id, entryId);

    expect(items).toHaveLength(MEMORY_WRITE_HISTORY_LIMIT);
    expect(items[0].lesson).toBe(`Lesson ${MEMORY_WRITE_HISTORY_LIMIT + 1}`);
  });

  it("isolates a decrypt failure to its own row", async () => {
    const { org, agent, entryId } = await setup();
    const laterSession = await insertSession(org.id, agent.id);
    await reinforceMemoryEntryWithWrite(org.id, agent.id, entryId, { source: "manual", lesson: "Fine.", sessionId: laterSession.id });
    const [insertRow] = (await writesFor(entryId)).filter((r) => r.kind === "insert");
    const buf = Buffer.from(insertRow.ciphertext, "base64");
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    await db.update(agentMemoryWrites).set({ ciphertext: buf.toString("base64") }).where(eq(agentMemoryWrites.id, insertRow.id));

    const items = await listMemoryEntryWrites(org.id, entryId);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "reinforce", lesson: "Fine." });
    expect(items[1]).toMatchObject({ kind: "insert", decryptError: true });
    expect(items[1].lesson).toBeUndefined();
    expect(items[1].reason).toBeUndefined();
  });

  it("returns nothing for another org", async () => {
    const { entryId } = await setup();
    const otherOrg = await insertOrg();

    expect(await listMemoryEntryWrites(otherOrg.id, entryId)).toEqual([]);
  });
});

describe("memoryEntryBelongsToAgent", () => {
  it("is true only for the owning org and agent", async () => {
    const { org, agent, entryId } = await setup();
    const otherAgent = await insertAgent(org.id);
    const otherOrg = await insertOrg();

    expect(await memoryEntryBelongsToAgent(org.id, agent.id, entryId)).toBe(true);
    expect(await memoryEntryBelongsToAgent(org.id, otherAgent.id, entryId)).toBe(false);
    expect(await memoryEntryBelongsToAgent(otherOrg.id, agent.id, entryId)).toBe(false);
    expect(await memoryEntryBelongsToAgent(org.id, agent.id, entryId + 999)).toBe(false);
  });
});
