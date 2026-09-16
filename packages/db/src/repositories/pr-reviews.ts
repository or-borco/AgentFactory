import { and, desc, eq } from "drizzle-orm";
import type { PrReview, PrReviewComment, ReviewVerdict } from "@agentfactory/core";
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
    status: row.status,
    verdict: row.verdict,
    summary: row.summary,
    comments: row.comments,
    postedAs: row.postedAs ?? undefined,
    githubReviewId: row.githubReviewId ?? undefined,
    url: row.url ?? undefined,
    commentCount: row.commentCount,
    truncated: row.truncated,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreatePendingPrReviewInput {
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  verdict: ReviewVerdict;
  summary: string;
  comments: PrReviewComment[];
  commentCount: number;
  truncated: boolean;
}

// Always inserts with status "pending" — a draft the worker produced, not yet posted to GitHub.
// See approvePrReview/discardPrReview for the only two ways a row leaves that state.
export async function createPendingPrReview(
  orgId: number,
  taskId: number,
  runId: number,
  input: CreatePendingPrReviewInput,
): Promise<PrReview> {
  const [row] = await db
    .insert(prReviews)
    .values({ orgId, taskId, runId, status: "pending", ...input })
    .returning();
  return toPrReview(row);
}

export interface PostedReviewInfo {
  postedAs: ReviewVerdict;
  githubReviewId: string;
  url: string;
}

// Flips a "pending" draft to "posted" once a human has approved it and the review actually
// reached GitHub. Scoped to orgId + status "pending" so this can never repost an already-posted
// or discarded row (a stale double-click on Approve is a no-op, not a duplicate GitHub review).
export async function approvePrReview(
  id: number,
  orgId: number,
  posted: PostedReviewInfo,
): Promise<PrReview | undefined> {
  const [row] = await db
    .update(prReviews)
    .set({ status: "posted", ...posted })
    .where(and(eq(prReviews.id, id), eq(prReviews.orgId, orgId), eq(prReviews.status, "pending")))
    .returning();
  return row ? toPrReview(row) : undefined;
}

// Marks a "pending" draft as rejected — it will never be posted. Same pending-only scoping as
// approvePrReview, for the same reason.
export async function discardPrReview(id: number, orgId: number): Promise<PrReview | undefined> {
  const [row] = await db
    .update(prReviews)
    .set({ status: "discarded" })
    .where(and(eq(prReviews.id, id), eq(prReviews.orgId, orgId), eq(prReviews.status, "pending")))
    .returning();
  return row ? toPrReview(row) : undefined;
}

export async function getPrReview(id: number, orgId: number): Promise<PrReview | undefined> {
  const [row] = await db
    .select()
    .from(prReviews)
    .where(and(eq(prReviews.id, id), eq(prReviews.orgId, orgId)));
  return row ? toPrReview(row) : undefined;
}

// Newest first, id as tiebreak — same-millisecond inserts are routine in tests, matching
// run-evals.ts's listEvalsForRun convention. Includes every status; callers that care about
// "the current actionable review" want reviews[0], not just posted ones.
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
