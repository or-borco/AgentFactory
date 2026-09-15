"use client";

import type { Agent } from "@agentfactory/core";
import { Select } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";

interface AssigneeSelectProps {
  agents: Agent[];
  value: number | undefined;
  disabled?: boolean;
  onChange: (agentId: number | undefined) => void;
}

// Editable assignee picker for the task detail page's meta panel. Kept as its own
// component (mirroring StatusMenu, the sibling inline-editor for status) so it's
// testable without the whole task detail page's session/polling machinery.
export function AssigneeSelect({ agents, value, disabled, onChange }: AssigneeSelectProps) {
  const { t } = useTranslation();
  return (
    <Select
      aria-label={t("taskDetail.assignee")}
      value={value !== undefined ? String(value) : ""}
      disabled={disabled}
      onChange={(v) => onChange(v ? Number(v) : undefined)}
      placeholder={t("taskDetail.unassigned")}
      options={agents.map((a) => ({ key: a.id, value: String(a.id), label: a.name }))}
      style={{
        padding: "3px 6px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--color-neutral-700)",
        background: "var(--color-surface)",
        color: value !== undefined ? "var(--color-text)" : "var(--color-neutral-600)",
        fontSize: 13,
      }}
    />
  );
}
