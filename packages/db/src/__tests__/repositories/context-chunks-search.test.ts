import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// The regression-guard test below forces the query planner off the team_id btree index and onto
// the HNSW index it exists to exercise (see the comment on that test). That only means anything
// if the planner-forcing SET statements and searchTeamContextChunks' own internal db.transaction()
// land on the exact same physical connection — not "probably the same one, since nothing else
// happens to be running concurrently in this file today." A pooled client with no `max` (the
// default in client.ts) can't promise that: a future edit to this file that adds an earlier test
// exercising a second connection would silently break the assumption, and the guard would revert
// to false-passing for the wrong reason — exactly the failure mode Task 3 exists to prevent.
//
// Replacing the db client for this whole file with a { max: 1 } pool — the same pattern
// setup.ts already uses for its own migration client — removes the ambiguity structurally: there
// is only one physical connection available to any code in this file, app code included, so
// "same connection" stops being an assumption about pool behaviour and becomes a fact about how
// many connections exist.
vi.mock("../../client.js", async () => {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const schema = await import("../../schema.js");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const queryClient = postgres(connectionString, { max: 1 });
  return { db: drizzle(queryClient, { schema }) };
});

import "../setup.js";
import { db } from "../../client.js";
import { insertContentBlob } from "../../repositories/content-blobs.js";
import { insertTeamContextChunks, searchTeamContextChunks } from "../../repositories/context-chunks.js";
import { createTeamContextItem } from "../../repositories/team-context-items.js";
import { getTeamForOrg } from "../../repositories/teams.js";
import { insertAgent, insertOrg, insertTeam } from "../fixtures.js";

const DIMENSIONS = 384;
const EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

// Unit vectors in the plane spanned by the first two axes, so cosine distance is exactly the
// angle: 0 rad sits on top of the query (distance 0), π/2 is orthogonal to it (distance 1).
// This makes "which rows the index reaches first" a property the test controls precisely.
function planeVector(angleRad: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[0] = Math.cos(angleRad);
  v[1] = Math.sin(angleRad);
  return v;
}

const QUERY = planeVector(0);

async function seedItem(orgId: number, teamId: number, title: string, shaSeed: string) {
  const sha256 = shaSeed.repeat(64).slice(0, 64);
  await insertContentBlob(orgId, sha256, 128, "text/markdown");
  const item = await createTeamContextItem({
    teamId, orgId, title, sizeBytes: 128, sha256, mime: "text/markdown",
  });
  if (!item) throw new Error(`fixture item ${sha256} unexpectedly conflicted`);
  return item;
}

async function seedChunks(
  itemId: number,
  teamId: number,
  total: number,
  angleFor: (i: number) => number,
) {
  for (let start = 0; start < total; start += 200) {
    const rows = [];
    for (let i = start; i < Math.min(start + 200, total); i++) {
      rows.push({
        itemId,
        teamId,
        chunkIdx: i,
        text: `chunk ${i} of item ${itemId}`,
        embedding: planeVector(angleFor(i)),
        embeddingModel: EMBEDDING_MODEL,
      });
    }
    await insertTeamContextChunks(rows);
  }
}

describe("searchTeamContextChunks", () => {
  // THE REGRESSION GUARD. hnsw.ef_search defaults to 40: the index yields ~40 candidates
  // GLOBALLY and the team_id predicate is applied afterwards, so a tenant-filtered top-k
  // silently under-returns — measured at 4 rows for a limit of 10 on a realistic table. The
  // fixture below makes that failure total rather than partial: the two noisy teams sit
  // directly on the query vector and own 2 000 of the 2 040 rows, so every one of the 40
  // candidates belongs to them and the filter removes all of them. Only the `set local
  // hnsw.iterative_scan = 'relaxed_order'` inside searchTeamContextChunks' transaction keeps
  // scanning until the requested 10 target-team rows are found. If that line is ever deleted,
  // this is the test that says so — nothing else in the system errors.
  it("returns exactly the requested number of rows for a team that owns none of the global top-k", async () => {
    const org = await insertOrg();
    const target = await insertTeam(org.id, { name: "Target" });
    const noisyA = await insertTeam(org.id, { name: "Noise A" });
    const noisyB = await insertTeam(org.id, { name: "Noise B" });

    const targetItem = await seedItem(org.id, target.id, "Target handbook", "a");
    const noisyItemA = await seedItem(org.id, noisyA.id, "Noise A doc", "b");
    const noisyItemB = await seedItem(org.id, noisyB.id, "Noise B doc", "c");

    await seedChunks(noisyItemA.id, noisyA.id, 1000, (i) => i * 1e-6);
    await seedChunks(noisyItemB.id, noisyB.id, 1000, (i) => 1e-3 + i * 1e-6);
    await seedChunks(targetItem.id, target.id, 40, (i) => Math.PI / 2 - i * 1e-4);
    // Without stats the planner may pick a sequential scan, which would pass this test for the
    // wrong reason. Analyzing is what makes the HNSW index the chosen plan.
    await db.execute(sql`analyze context_chunks`);

    // At this fixture's row count (2,040), Postgres's cost estimator prefers
    // context_chunks_team_id_idx (a plain btree on team_id) plus a top-N sort over the HNSW
    // index, even after ANALYZE — that plan filters on team_id before ranking, so it never hits
    // the "candidates gathered globally, then filtered" failure mode this test exists to catch.
    // Disabling the competing scan methods is what forces the planner onto
    // context_chunks_embedding_idx (HNSW), so this test actually exercises the same code path
    // production traffic hits at realistic table sizes. Confirmed by EXPLAIN ANALYZE: with these
    // three off and iterative_scan unset, the HNSW scan returns 0 rows for the target team; with
    // iterative_scan restored, it returns the correct 10.
    //
    // These are session-level `SET` (not `SET LOCAL`) on the connection, not a transaction: the
    // module-level mock above makes `db` a { max: 1 } client for this whole file, so this really
    // is the one connection searchTeamContextChunks' internal db.transaction() will use — not an
    // inference from the absence of concurrent queries. The settings are still explicitly
    // restored in `finally` so nothing leaks to the other tests in this file, which share the
    // same single connection.
    await db.execute(sql`set enable_seqscan = off`);
    await db.execute(sql`set enable_bitmapscan = off`);
    await db.execute(sql`set enable_indexscan = off`);
    try {
      const matches = await searchTeamContextChunks(target.id, QUERY, 10);

      expect(matches).toHaveLength(10);
      expect(new Set(matches.map((m) => m.itemId))).toEqual(new Set([targetItem.id]));
    } finally {
      await db.execute(sql`set enable_seqscan = on`);
      await db.execute(sql`set enable_bitmapscan = on`);
      await db.execute(sql`set enable_indexscan = on`);
    }
  });

  // relaxed_order buys recall by allowing candidates back slightly out of order, so the outer
  // ORDER BY in searchTeamContextChunks is what makes the persisted `rank` mean anything.
  it("returns matches sorted by descending similarity", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    const item = await seedItem(org.id, team.id, "Handbook", "d");
    await seedChunks(item.id, team.id, 60, (i) => (i % 60) * 0.02);

    const matches = await searchTeamContextChunks(team.id, QUERY, 10);

    const scores = matches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBeGreaterThan(scores[scores.length - 1]);
    // pgvector stores real (float32), so similarity is asserted with a tolerance, never equality.
    expect(scores[0]).toBeCloseTo(1, 4);
  });

  it("joins the owning document's title and never returns another team's chunk", async () => {
    const org = await insertOrg();
    const mine = await insertTeam(org.id, { name: "Mine" });
    const theirs = await insertTeam(org.id, { name: "Theirs" });
    const myItem = await seedItem(org.id, mine.id, "Incident runbook", "e");
    const theirItem = await seedItem(org.id, theirs.id, "Their runbook", "f");
    await seedChunks(myItem.id, mine.id, 3, () => 0.1);
    await seedChunks(theirItem.id, theirs.id, 3, () => 0);

    const matches = await searchTeamContextChunks(mine.id, QUERY, 10);

    expect(matches).toHaveLength(3);
    expect(matches.every((m) => m.itemTitle === "Incident runbook")).toBe(true);
    expect(matches.every((m) => m.itemId === myItem.id)).toBe(true);
    expect(matches.map((m) => m.chunkIdx).sort()).toEqual([0, 1, 2]);
  });

  // The cross-org guard. agents.team_id can point at another org's team today, and the query
  // fed to retrieval is built from task.title/description — attacker-controlled text. The team
  // never resolves, so the search is never reached; the second assertion proves the chunks
  // really are there, so the first is scoping working rather than an empty fixture.
  it("is unreachable across orgs: an org A agent pointed at an org B team resolves no team", async () => {
    const orgA = await insertOrg();
    const orgB = await insertOrg();
    const teamB = await insertTeam(orgB.id, { name: "Org B team" });
    const itemB = await seedItem(orgB.id, teamB.id, "Org B runbook", "9");
    await seedChunks(itemB.id, teamB.id, 5, () => 0);
    const agent = await insertAgent(orgA.id, { teamId: teamB.id });

    await expect(getTeamForOrg(agent.teamId!, agent.orgId)).resolves.toBeUndefined();
    await expect(getTeamForOrg(teamB.id, orgB.id)).resolves.toBeDefined();
    await expect(searchTeamContextChunks(teamB.id, QUERY, 10)).resolves.toHaveLength(5);
  });

  it("returns an empty array for a team with no chunks", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    await expect(searchTeamContextChunks(team.id, QUERY, 10)).resolves.toEqual([]);
  });
});
