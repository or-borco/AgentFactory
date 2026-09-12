"use client";

import { useState } from "react";
import { Button, TooltipBubble } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TrashIcon } from "@/lib/icons";

export function DeleteSkillButton({
  skillId,
  skillName,
  assignedAgentNames,
  onDeleted,
  onError,
}: {
  skillId: number;
  skillName: string;
  assignedAgentNames: string[];
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const blocked = assignedAgentNames.length > 0;

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await apiFetch<void>(`/api/skills/${skillId}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("common.loadError"));
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="group/tooltip relative">
      <Button variant="secondary" onClick={() => setConfirming(true)} disabled={blocked}>
        <TrashIcon size={14} />
        {t("skills.detail.deleteButton")}
      </Button>
      {blocked && (
        <TooltipBubble
          label={t("skills.detail.deleteBlockedTooltip", { agents: assignedAgentNames.join(", ") })}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={t("skills.detail.confirmDeleteTitle", { name: skillName })}
          message={t("skills.detail.confirmDeleteMessage")}
          confirmLabel={deleting ? t("skills.detail.deleting") : t("skills.detail.confirmDeleteButton")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setConfirming(false)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
