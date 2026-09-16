"use client";

import { useState } from "react";
import { Button } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { apiFetch } from "@/lib/api-client";
import type { Task } from "@agentfactory/core";
import confirmationStyles from "./ConfirmationBanner.module.css";

interface WriteBackFailureBannerProps {
  task: Task;
  onDismiss: () => void;
}

// Surfaces Design decision 13's persisted write-back-failure signal outside the run transcript,
// where it would otherwise be invisible unless someone happened to open that specific run.
// Mirrors RepoMapWaitBanner's use of ConfirmationBanner.module.css rather than introducing new
// styling.
export function WriteBackFailureBanner({ task, onDismiss }: WriteBackFailureBannerProps) {
  const { t } = useTranslation();
  const [dismissing, setDismissing] = useState(false);

  const failure = task.externalRef?.writeBackFailure;
  if (!failure || !task.externalRef) return null;

  const provider = t(`connections.provider.${task.externalRef.provider}`);

  const handleDismiss = async () => {
    if (!task.externalRef) return;
    setDismissing(true);
    try {
      await apiFetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ externalRef: { ...task.externalRef, writeBackFailure: undefined } }),
      });
      onDismiss();
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div className={confirmationStyles.banner}>
      <p className={confirmationStyles.title}>{t("writeBackFailure.title", { provider })}</p>
      <p className={confirmationStyles.body}>{failure.message}</p>
      <div className={confirmationStyles.choices}>
        <a
          href={task.externalRef.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 13, color: "var(--color-accent)", textDecoration: "none", alignSelf: "center" }}
        >
          {t("writeBackFailure.viewInProvider", { provider })}
        </a>
        <Button type="button" variant="secondary" disabled={dismissing} onClick={handleDismiss}>
          {t("writeBackFailure.dismiss")}
        </Button>
      </div>
    </div>
  );
}
