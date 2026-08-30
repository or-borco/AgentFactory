import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";

// The extension is a precondition for context_chunks.embedding (a vector(384) column) and its
// HNSW index, both of which arrive in a later PR. It is asserted here, in its own file, because
// its failure mode in CI is a migration error with no obvious owner — this test names the owner.
describe("pgvector extension", () => {
  it("is installed by the migrations", async () => {
    const rows = await db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    expect(Array.from(rows)).toEqual([{ extname: "vector" }]);
  });

  it("can round-trip a vector literal through the cosine distance operator", async () => {
    const rows = await db.execute<{ distance: number }>(
      sql`select ('[1,0,0]'::vector <=> '[1,0,0]'::vector) as distance`,
    );
    expect(Array.from(rows)[0].distance).toBeCloseTo(0, 6);
  });
});
