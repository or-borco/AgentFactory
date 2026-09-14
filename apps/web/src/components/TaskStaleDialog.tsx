"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import type { Task } from "@agentfactory/core";
import type { ExternalIssue } from "@agentfactory/integrations";

interface TaskStaleDialogProps {
  task: Task;
  latest: ExternalIssue;
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void | Promise<void>;
  onSecondary: () => void | Promise<void>;
  onClose: () => void;
}

// One dialog, two callers: the Refresh action next to the linked-issue badge (Update task /
// Dismiss) and the Run button's 409 task_stale catch (Update and run / Run anyway) — see
// "Flow: refresh and the pre-run staleness check" in
// docs/superpowers/specs/2026-09-12-jira-integration-design.md. Only the labels and the two
// callbacks differ per caller; the diff view itself is identical either way.
export function TaskStaleDialog({
  task,
  latest,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onClose,
}: TaskStaleDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const provider = task.externalRef ? t(`connections.provider.${task.externalRef.provider}`) : "";

  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("taskDetail.sync.dialogTitle")} onClose={onClose}>
      <p className="text-sm text-[var(--color-neutral-400)]">{t("taskDetail.sync.dialogBody")}</p>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <div style={diffLabelStyle}>{t("taskDetail.sync.oldLabel")}</div>
          <p style={diffTitleStyle}>{task.title}</p>
          <p style={diffBodyStyle}>{task.description || "—"}</p>
        </div>
        <div>
          <div style={diffLabelStyle}>{t("taskDetail.sync.newLabel", { provider })}</div>
          <p style={diffTitleStyle}>{latest.title}</p>
          <p style={diffBodyStyle}>{latest.description || "—"}</p>
        </div>
      </div>

      {/* Attachments are additive (new files present on the upstream issue), not part of the
          title/description diff above, so they get their own flat list rather than an old/new pair. */}
      {latest.attachments.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={diffLabelStyle}>{t("taskDetail.sync.attachmentsLabel")}</div>
          <ul style={{ marginTop: 6, listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {latest.attachments.map((attachment) => (
              <li key={attachment.filename} style={{ fontSize: 12.5, color: "var(--color-neutral-400)" }}>
                {attachment.filename}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={() => run(onSecondary)}>
          {secondaryLabel}
        </Button>
        <Button type="button" disabled={busy} onClick={() => run(onPrimary)}>
          {primaryLabel}
        </Button>
      </div>
    </Modal>
  );
}

const diffLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--color-neutral-500)",
};

const diffTitleStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--color-text)",
};

const diffBodyStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "var(--color-neutral-400)",
  whiteSpace: "pre-wrap",
};
