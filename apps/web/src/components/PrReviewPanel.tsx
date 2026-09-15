"use client";

import { useEffect, useState } from "react";
import type { PrReview, ReviewVerdict } from "@agentfactory/core";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

// Mirrors RunContextPanel/RunEvalPanel's fetch-state shape: an explicit "error" status so a
// failed fetch is never silently indistinguishable from "no review has been posted yet" (both
// would otherwise leave `reviews` at its initial `[]`).
type ReviewFetchState = { status: "error" } | { status: "loaded"; reviews: PrReview[] };

// Keyed on the verdict union so a new verdict is a compile error here, never a blank mark —
// same pattern RunEvalPanel uses for EvalRequirement["verdict"].
const VERDICT_LABEL_KEYS: Record<ReviewVerdict, TranslationKey> = {
  comment: "taskDetail.reviewVerdictComment",
  request_changes: "taskDetail.reviewVerdictRequestChanges",
};

// A review posts once per run (see Task 5/6's worker changes), and the task page's own
// run-status poll is what tells the user a new run finished — so this panel only needs a
// fetch-on-mount, no polling of its own. Its parent should remount/refetch it once a new run
// completes.
export function PrReviewPanel({ taskId }: { taskId: number }) {
  const { t } = useTranslation();
  const [state, setState] = useState<ReviewFetchState>({ status: "loaded", reviews: [] });

  useEffect(() => {
    let cancelled = false;
    apiFetch<PrReview[]>(`/api/tasks/${taskId}/pr-reviews`)
      .then((data) => {
        if (!cancelled) setState({ status: "loaded", reviews: data });
      })
      .catch(() => {
        // Same rationale as RunContextPanel/RunEvalPanel: catch it so it isn't an unhandled
        // rejection, and track it as its own state so the panel can say the fetch failed
        // instead of rendering nothing (which would look identical to "no review yet").
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (state.status === "error") {
    return (
      <section style={{ padding: "20px 24px" }}>
        <p style={{ fontSize: 13, color: "var(--color-status-amber)" }}>
          {t("taskDetail.reviewLoadError")}
        </p>
      </section>
    );
  }

  const { reviews } = state;
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
        {t(VERDICT_LABEL_KEYS[latest.verdict])}
        {latest.postedAs !== latest.verdict && ` (${t("taskDetail.reviewPostedAsCommentFallback")})`}
      </p>
      <p style={{ fontSize: 13, color: "var(--color-neutral-500)", margin: "0 0 8px" }}>
        {t("taskDetail.reviewCommentCount", { count: latest.commentCount })}
      </p>
      <a
        href={latest.url}
        target="_blank"
        rel="noopener noreferrer"
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
