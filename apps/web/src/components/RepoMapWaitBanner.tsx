"use client";

import { Button } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import type { RepoMapWaitGate } from "@/lib/use-repo-map-wait-gate";

interface RepoMapWaitBannerProps {
  gate: RepoMapWaitGate;
}

// Renders the two states from docs/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md's
// approved mockups: the decision prompt, and the waiting screen with its escape hatch. Shared by
// both the task-creation and task-edit forms.
export function RepoMapWaitBanner({ gate }: RepoMapWaitBannerProps) {
  const { t } = useTranslation();

  if (gate.state === "hidden" || gate.state === "checking") return null;

  if (gate.state === "prompt") {
    return (
      <div style={bannerStyle}>
        <p style={{ margin: "0 0 6px 0", fontWeight: 600 }}>{t("tasks.repoMapWait.title")}</p>
        <p style={{ margin: "0 0 12px 0", fontSize: 13, opacity: 0.85 }}>{t("tasks.repoMapWait.body")}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <Button type="button" variant="primary" onClick={gate.startWaiting}>
            {t("tasks.repoMapWait.startMapping")}
          </Button>
          <Button type="button" variant="secondary" onClick={gate.startNow}>
            {t("tasks.repoMapWait.startNow")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={bannerStyle}>
      <p style={{ margin: "0 0 8px 0", fontWeight: 600 }}>{t("tasks.repoMapWait.waitingTitle")}</p>
      <p style={{ margin: "0 0 12px 0", fontSize: 13, opacity: 0.85 }}>
        {gate.fallbackMessage
          ? t(`tasks.repoMapWait.${gate.fallbackMessage === "enqueue-failed" ? "enqueueFailed" : "pollFailed"}`)
          : t("tasks.repoMapWait.waitingBody")}
      </p>
      <Button type="button" variant="secondary" onClick={gate.startNow}>
        {t("tasks.repoMapWait.escapeHatch")}
      </Button>
    </div>
  );
}

const bannerStyle: React.CSSProperties = {
  border: "1px solid var(--color-neutral-700)",
  borderRadius: "var(--radius-md)",
  padding: 14,
  background: "var(--color-surface)",
};
