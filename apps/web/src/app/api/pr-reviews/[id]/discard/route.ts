import { NextResponse } from "next/server";
import { discardPrReview, getPrReview } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const review = await getPrReview(Number(id), ctx.orgId);
  if (!review) return NextResponse.json({ error: "Review not found" }, { status: 404 });
  if (review.status !== "pending") {
    return NextResponse.json({ error: `Review is already ${review.status}` }, { status: 409 });
  }

  const updated = await discardPrReview(review.id, ctx.orgId);
  if (!updated) return NextResponse.json({ error: `Review is already ${review.status}` }, { status: 409 });

  return NextResponse.json(updated);
}
