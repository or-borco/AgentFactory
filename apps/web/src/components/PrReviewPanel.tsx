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

// Sits as a sticky footer bar between the transcript's scroll area and the reply box — an
// approval gate is an action item, not conversation content, so it must stay visible regardless
// of scroll position rather than being just another message in the transcript. Renders nothing
// when there's no review to show.
export function PrReviewPanel({ taskId, runStatus }: { taskId: number; runStatus?: string | null }) {
  const { t } = useTranslation();
  const [state, setState] = useState<ReviewFetchState>({ status: "loaded", reviews: [] });
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState(false);

  // A review drafts once per run (see the worker's PR-review detection), and the worker writes
  // that row well after the page's own run-status poll first observes the run — a fetch pinned
  // to mount alone would race that write and permanently miss a review drafted after the page
  // loaded. `runStatus` is the same value the page already polls to know a run is in flight, so
  // refetching whenever it changes (queued → running → done) catches the row as soon as it
  // exists, without this panel needing its own poll loop. Approve/discard update local state
  // directly (no refetch) since this is the only place either action happens.
  useEffect(() => {
    let cancelled = false;
    apiFetch<PrReview[]>(`/api/tasks/${taskId}/pr-reviews`)
      .then((data) => {
        if (!cancelled) setState({ status: "loaded", reviews: data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, runStatus]);

  if (state.status === "error") {
    return (
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--color-divider)", padding: "10px 20px", background: "var(--color-bg)" }}>
        <p style={{ fontSize: 13, color: "var(--color-status-amber)", margin: 0 }}>{t("taskDetail.reviewLoadError")}</p>
      </div>
    );
  }

  const { reviews } = state;
  if (reviews.length === 0) return null;
  // listPrReviewsForTask returns newest first — the most recent draft/posted/discarded review is
  // what's worth surfacing here.
  const latest = reviews[0];

  async function runAction(action: "approve" | "discard") {
    setActionPending(true);
    setActionError(false);
    try {
      const updated = await apiFetch<PrReview>(`/api/pr-reviews/${latest.id}/${action}`, { method: "POST" });
      setState({ status: "loaded", reviews: [updated, ...reviews.slice(1)] });
    } catch {
      setActionError(true);
    } finally {
      setActionPending(false);
    }
  }

  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: "1px solid var(--color-divider)",
        padding: "10px 20px",
        background: "var(--color-bg)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: "var(--color-neutral-500)",
              flexShrink: 0,
            }}
          >
            {t("taskDetail.reviewSectionTitle")}
          </span>
          <span style={{ fontSize: 13 }}>
            {t(VERDICT_LABEL_KEYS[latest.verdict])}
            {latest.status === "posted" &&
              latest.postedAs !== latest.verdict &&
              ` (${t("taskDetail.reviewPostedAsCommentFallback")})`}
          </span>
          <span style={{ fontSize: 13, color: "var(--color-neutral-500)" }}>
            {t("taskDetail.reviewCommentCount", { count: latest.commentCount })}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {latest.status === "posted" && (
            <a
              href={latest.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 13, color: "var(--color-accent)", textDecoration: "none" }}
            >
              {t("taskDetail.reviewViewOnGithub")}
            </a>
          )}

          {latest.status === "discarded" && (
            <p style={{ fontSize: 13, color: "var(--color-neutral-500)", margin: 0 }}>{t("taskDetail.reviewDiscardedNotice")}</p>
          )}

          {latest.status === "pending" && (
            <>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-status-amber)", flexShrink: 0 }}>
                {t("taskDetail.reviewPendingTitle")}
              </span>
              <button
                type="button"
                disabled={actionPending}
                onClick={() => runAction("approve")}
                style={{
                  fontSize: 13,
                  padding: "6px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-accent-600)",
                  background: "var(--color-accent-900)",
                  color: "var(--color-accent-300)",
                  cursor: actionPending ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {actionPending ? t("taskDetail.reviewApproving") : t("taskDetail.reviewApproveButton")}
              </button>
              <button
                type="button"
                disabled={actionPending}
                onClick={() => runAction("discard")}
                style={{
                  fontSize: 13,
                  padding: "6px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--color-divider)",
                  background: "transparent",
                  color: "var(--color-neutral-400)",
                  cursor: actionPending ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {actionPending ? t("taskDetail.reviewDiscarding") : t("taskDetail.reviewDiscardButton")}
              </button>
            </>
          )}
        </div>
      </div>

      {actionError && <p style={{ fontSize: 12, color: "var(--color-status-amber)", margin: 0 }}>{t("taskDetail.reviewActionError")}</p>}

      {latest.truncated && (
        <p style={{ fontSize: 12, color: "var(--color-status-amber)", margin: 0 }}>{t("taskDetail.reviewTruncatedNotice")}</p>
      )}
    </div>
  );
}
