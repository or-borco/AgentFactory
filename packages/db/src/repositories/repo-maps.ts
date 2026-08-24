import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { repoMaps } from "../schema";

const CONTENT_MAX_CHARS = 16384;

// Worker-internal shape, not part of @agentfactory/core — nothing outside apps/worker reads a
// repo map today, same reasoning as SandboxSpec/Sandbox in apps/worker/src/sandbox/types.ts.
export interface RepoMap {
  id: number;
  orgId: number;
  repoFullName: string;
  commitSha: string;
  content: string;
  generationCostUsd: number;
  generationTokens: number;
  createdAt: string;
}

function toRepoMap(row: typeof repoMaps.$inferSelect): RepoMap {
  return {
    id: row.id,
    orgId: row.orgId,
    repoFullName: row.repoFullName,
    commitSha: row.commitSha,
    content: row.content,
    generationCostUsd: row.generationCostUsd,
    generationTokens: row.generationTokens,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getRepoMap(
  orgId: number,
  repoFullName: string,
  commitSha: string,
): Promise<RepoMap | undefined> {
  const [row] = await db
    .select()
    .from(repoMaps)
    .where(
      and(eq(repoMaps.orgId, orgId), eq(repoMaps.repoFullName, repoFullName), eq(repoMaps.commitSha, commitSha)),
    );
  return row ? toRepoMap(row) : undefined;
}

export interface NewRepoMapInput {
  orgId: number;
  repoFullName: string;
  commitSha: string;
  content: string;
  generationCostUsd: number;
  generationTokens: number;
}

// Truncates defensively (belt-and-suspenders alongside the repo_maps_content_max_length CHECK
// constraint) and no-ops on a concurrent insert for the same (org, repo, sha) — two runs can
// race to generate a map for a brand-new commit; only the first insert needs to win.
export async function insertRepoMap(input: NewRepoMapInput): Promise<void> {
  await db
    .insert(repoMaps)
    .values({
      orgId: input.orgId,
      repoFullName: input.repoFullName,
      commitSha: input.commitSha,
      content: input.content.slice(0, CONTENT_MAX_CHARS),
      generationCostUsd: input.generationCostUsd,
      generationTokens: input.generationTokens,
    })
    .onConflictDoNothing();
}
