"use client";

import { useEffect, useState } from "react";
import type { PrReview } from "@agentfactory/core";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

// A review posts once per run (see Task 5/6's worker changes), and the task page's own
// run-status poll is what tells the user a new run finished — so this panel only needs a
// fetch-on-mount, no polling of its own. Its parent should remount/refetch it once a new run
// completes.
export function PrReviewPanel({ taskId }: { taskId: number }) {
  const { t } = useTranslation();
  const [reviews, setReviews] = useState<PrReview[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PrReview[]>(`/api/tasks/${taskId}/pr-reviews`).then((data) => {
      if (!cancelled) setReviews(data);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (reviews.length === 0) return null;
  // listPrReviewsForTask returns newest first — the most recent posted review is what's
  // worth surfacing here.
  const latest = reviews[0];

  return (
    <section style={{ padding: "20px 24px" }}>
      <h3
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--color-neutral-300)",
          marginBottom: 10,
        }}
      >
        {t("taskDetail.reviewSectionTitle")}
      </h3>
      <p style={{ fontSize: 13, margin: "0 0 4px" }}>
        {latest.verdict === "request_changes"
          ? t("taskDetail.reviewVerdictRequestChanges")
          : t("taskDetail.reviewVerdictComment")}
        {latest.postedAs !== latest.verdict && ` (${t("taskDetail.reviewPostedAsCommentFallback")})`}
      </p>
      <p style={{ fontSize: 13, color: "var(--color-neutral-500)", margin: "0 0 8px" }}>
        {t("taskDetail.reviewCommentCount", { count: latest.commentCount })}
      </p>
      <a
        href={latest.url}
        target="_blank"
        rel="noreferrer"
        style={{ fontSize: 13, color: "var(--color-accent)", textDecoration: "none" }}
      >
        {t("taskDetail.reviewViewOnGithub")}
      </a>
      {latest.truncated && (
        <p style={{ fontSize: 12, color: "var(--color-status-amber)", margin: "8px 0 0" }}>
          {t("taskDetail.reviewTruncatedNotice")}
        </p>
      )}
    </section>
  );
}
