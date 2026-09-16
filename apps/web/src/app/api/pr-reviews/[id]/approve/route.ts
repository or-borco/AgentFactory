import { NextResponse } from "next/server";
import { approvePrReview, getPrReview } from "@agentfactory/db";
import { resolveScmConnection } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";

// The one place a review actually reaches GitHub — the worker only ever drafts a "pending" row
// (see apps/worker/src/worker.ts). Scoped to status "pending" at the DB layer (approvePrReview),
// so a stale double-submit can't post the same review twice.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const review = await getPrReview(Number(id), ctx.orgId);
  if (!review) return NextResponse.json({ error: "Review not found" }, { status: 404 });
  if (review.status !== "pending") {
    return NextResponse.json({ error: `Review is already ${review.status}` }, { status: 409 });
  }

  const resolved = await resolveScmConnection(ctx.orgId, review.repoFullName);
  if (!resolved) {
    return NextResponse.json(
      { error: `No connected GitHub provider can post the review for ${review.repoFullName}` },
      { status: 409 },
    );
  }

  const posted = await resolved.provider.postReview(resolved.connection, review.repoFullName, review.prNumber, {
    summary: review.summary,
    verdict: review.verdict,
    comments: review.comments,
  });

  const updated = await approvePrReview(review.id, ctx.orgId, {
    postedAs: posted.postedAs,
    githubReviewId: posted.id,
    url: posted.url,
  });
  if (!updated) return NextResponse.json({ error: `Review is already ${review.status}` }, { status: 409 });

  return NextResponse.json(updated);
}
