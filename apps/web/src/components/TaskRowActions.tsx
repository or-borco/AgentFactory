"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Task } from "@agentfactory/core";
import { TooltipBubble } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EditIcon, RunIcon, StopIcon, CheckIcon, TrashIcon } from "@/lib/icons";

interface TaskRowActionsProps {
  task: Task;
  onRun: () => Promise<void>;
  onMarkDone: () => Promise<void>;
  onDelete: () => Promise<void>;
}

// Shared box every action control renders inside: 28x28px, --radius-sm corners, a
// neutral-500 icon that only tints on hover — see Task Row Quick Actions.pdf p.3
// ("Button box 28 × 28 px", "Icon 15 px, Phosphor", "Corner --radius-sm (4 px)").
const ACTION_BOX_CLASS =
  "inline-flex h-[28px] w-[28px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-neutral-500)] transition-colors " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)]";

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  disabledOpacity = 0.3,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  disabledOpacity?: number;
  destructive?: boolean;
}) {
  return (
    <span className="group/tooltip relative inline-flex">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        style={disabled ? { opacity: disabledOpacity } : undefined}
        className={
          ACTION_BOX_CLASS +
          " disabled:cursor-not-allowed " +
          (destructive
            ? "enabled:hover:bg-[color-mix(in_srgb,var(--color-status-red)_18%,transparent)] enabled:hover:text-[var(--color-status-red)]"
            : "enabled:hover:bg-[var(--color-neutral-900)]")
        }
      >
        {icon}
      </button>
      <TooltipBubble label={label} placement="top" />
    </span>
  );
}

// Hover-reveal quick-action cluster for one Tasks-list row, per Task Row Quick
// Actions.pdf. The parent <tr> carries `className="group"`; this cluster fades in on
// `group-hover`/`group-focus-within` rather than unmounting, so disabled buttons keep
// their slot (the design's "disabled, not hidden" rule) and Tab can reach them.
export function TaskRowActions({ task, onRun, onMarkDone, onDelete }: TaskRowActionsProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const canEdit = !task.sessionId;
  const canRun = task.status === "assigned" && !task.sessionId && !!task.assigneeAgentId;
  const canStop = !!task.sessionId && !["done", "failed", "cancelled"].includes(task.status);
  const isDone = task.status === "done";

  const editLabel = canEdit ? t("tasks.rowActions.edit") : t("tasks.rowActions.editDisabledStarted");

  const runLabel = canRun
    ? t("tasks.rowActions.run")
    : task.assigneeAgentId
      ? t("tasks.rowActions.runDisabledStarted")
      : t("tasks.rowActions.runDisabledNoAgent");

  const handleRun = async () => {
    if (!canRun || running) return;
    setRunning(true);
    try {
      await onRun();
    } catch {
      // Run navigates away on success (see the parent's onRun), so there is nothing to
      // reset there; only reset the busy state on failure, when we stay on this page.
      setRunning(false);
    }
  };

  const handleMarkDone = async () => {
    if (isDone || markingDone) return;
    setMarkingDone(true);
    try {
      await onMarkDone();
    } finally {
      setMarkingDone(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <>
      <div
        className={
          "inline-flex items-center gap-1 opacity-0 pointer-events-none transition-opacity duration-100 " +
          "group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
        }
      >
        <ActionButton
          icon={<EditIcon size={15} />}
          label={editLabel}
          onClick={() => router.push(`/tasks/${task.id}/edit`)}
          disabled={!canEdit}
        />

        <ActionButton
          icon={<RunIcon size={15} />}
          label={runLabel}
          onClick={handleRun}
          disabled={!canRun || running}
        />

        <ActionButton
          icon={<StopIcon size={15} />}
          label={t("tasks.rowActions.stop")}
          onClick={() => {}}
          disabled={!canStop}
        />

        <ActionButton
          icon={<CheckIcon size={15} />}
          label={t("tasks.rowActions.markDone")}
          onClick={handleMarkDone}
          disabled={isDone || markingDone}
          disabledOpacity={0.2}
        />

        <ActionButton
          icon={<TrashIcon size={15} />}
          label={t("tasks.rowActions.delete")}
          onClick={() => setConfirmingDelete(true)}
          destructive
        />
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title={t("taskDetail.confirmDeleteTitle", { title: task.title })}
          message={t("taskDetail.confirmDeleteMessage")}
          confirmLabel={deleting ? t("taskDetail.deleting") : t("taskDetail.confirmDeleteButton")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </>
  );
}
