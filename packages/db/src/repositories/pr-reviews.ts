import { and, desc, eq } from "drizzle-orm";
import type { PrReview, ReviewVerdict } from "@agentfactory/core";
import { db } from "../client";
import { prReviews } from "../schema";

function toPrReview(row: typeof prReviews.$inferSelect): PrReview {
  return {
    id: row.id,
    orgId: row.orgId,
    taskId: row.taskId,
    runId: row.runId,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    baseSha: row.baseSha,
    headSha: row.headSha,
    verdict: row.verdict,
    postedAs: row.postedAs,
    githubReviewId: row.githubReviewId,
    url: row.url,
    commentCount: row.commentCount,
    truncated: row.truncated,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreatePrReviewInput {
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  verdict: ReviewVerdict;
  postedAs: ReviewVerdict;
  githubReviewId: string;
  url: string;
  commentCount: number;
  truncated: boolean;
}

export async function createPrReview(
  orgId: number,
  taskId: number,
  runId: number,
  input: CreatePrReviewInput,
): Promise<PrReview> {
  const [row] = await db
    .insert(prReviews)
    .values({ orgId, taskId, runId, ...input })
    .returning();
  return toPrReview(row);
}

// Newest first, id as tiebreak — same-millisecond inserts are routine in tests, matching
// run-evals.ts's listEvalsForRun convention.
export async function listPrReviewsForTask(taskId: number, orgId: number): Promise<PrReview[]> {
  const rows = await db
    .select()
    .from(prReviews)
    .where(and(eq(prReviews.taskId, taskId), eq(prReviews.orgId, orgId)))
    .orderBy(desc(prReviews.createdAt), desc(prReviews.id));
  return rows.map(toPrReview);
}

export async function getLatestPrReview(taskId: number, orgId: number): Promise<PrReview | undefined> {
  const [row] = await db
    .select()
    .from(prReviews)
    .where(and(eq(prReviews.taskId, taskId), eq(prReviews.orgId, orgId)))
    .orderBy(desc(prReviews.createdAt), desc(prReviews.id))
    .limit(1);
  return row ? toPrReview(row) : undefined;
}
