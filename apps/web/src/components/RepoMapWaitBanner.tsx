"use client";

import { useEffect, useState } from "react";
import { Button } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import type { RepoMapWaitGate } from "@/lib/use-repo-map-wait-gate";
import type { TranslationKey } from "@/lib/i18n/paths";
import confirmationStyles from "./ConfirmationBanner.module.css";
import styles from "./RepoMapWaitBanner.module.css";

interface RepoMapWaitBannerProps {
  gate: RepoMapWaitGate;
}

// Perceived-progress only — the backend exposes no real per-stage signal (see
// AgentFactoryContext/superpowers/specs/2026-09-05-repo-map-wait-progress-design.md). These boundaries are a
// rough approximation weighted toward the real proportions (provisioning+clone is quick,
// generation dominates at 33-38s), not a claim of accurate telemetry.
function progressLabelKey(elapsedSeconds: number): TranslationKey {
  if (elapsedSeconds < 5) return "tasks.repoMapWait.progressSettingUp";
  if (elapsedSeconds < 30) return "tasks.repoMapWait.progressGenerating";
  return "tasks.repoMapWait.progressTakingLonger";
}

function useElapsedWhileWaiting(waiting: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  // Reset the ticker synchronously during render on the transition into or out of "waiting" —
  // React's own recommended alternative to setState-in-effect for this exact case, see the same
  // pattern in apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx.
  const [wasWaiting, setWasWaiting] = useState(waiting);
  if (waiting !== wasWaiting) {
    setWasWaiting(waiting);
    setElapsed(0);
  }

  useEffect(() => {
    if (!waiting) return;
    const interval = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [waiting]);

  return elapsed;
}

// Renders the two states from AgentFactoryContext/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md's
// approved mockups: the decision prompt, and the waiting screen with its escape hatch. Shared by
// both the task-creation and task-edit forms.
export function RepoMapWaitBanner({ gate }: RepoMapWaitBannerProps) {
  const { t } = useTranslation();
  const elapsed = useElapsedWhileWaiting(gate.state === "waiting");

  if (gate.state === "hidden" || gate.state === "checking") return null;

  if (gate.state === "prompt") {
    return (
      <div className={confirmationStyles.banner}>
        <p className={confirmationStyles.title}>{t("tasks.repoMapWait.title")}</p>
        <p className={confirmationStyles.body}>{t("tasks.repoMapWait.body")}</p>
        <div className={confirmationStyles.choices}>
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
    <div className={confirmationStyles.banner}>
      <p className={confirmationStyles.title}>{t("tasks.repoMapWait.waitingTitle")}</p>
      <p className={confirmationStyles.body}>
        {gate.fallbackMessage
          ? t(`tasks.repoMapWait.${gate.fallbackMessage === "enqueue-failed" ? "enqueueFailed" : "pollFailed"}`)
          : t("tasks.repoMapWait.waitingBody")}
      </p>
      {!gate.fallbackMessage && (
        <div className={styles.progress}>
          <span className={styles.spinner} />
          <span className={styles.progressLabel}>{t(progressLabelKey(elapsed))}</span>
        </div>
      )}
      <Button type="button" variant="secondary" onClick={gate.startNow}>
        {t("tasks.repoMapWait.escapeHatch")}
      </Button>
    </div>
  );
}
