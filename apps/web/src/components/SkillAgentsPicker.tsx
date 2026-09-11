"use client";

import { useCallback, useEffect, useState } from "react";
import type { Agent } from "@agentfactory/core";
import { Badge, MultiSelectCheckboxList, type MultiSelectItem } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

export interface SkillAssignment {
  agentId: number;
  agentName: string;
  skillVersionId: number;
  version: number;
}

export function SkillAgentsPicker({
  skillId,
  currentVersionNumber,
  assignments,
  onAssignmentsChange,
}: {
  skillId: number;
  currentVersionNumber?: number;
  assignments: SkillAssignment[];
  onAssignmentsChange: (next: SkillAssignment[]) => void;
}) {
  const { t } = useTranslation();
  const [allAgents, setAllAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAgentIds, setBusyAgentIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const agents = await apiFetch<Agent[]>("/api/agents");
      setAllAgents(agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    }
  }, [t]);

  useEffect(() => {
    // Initial fetch on mount; load() is async, so any setState it makes lands in a later
    // microtask, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function handleToggle(agentId: number) {
    setError(null);
    setBusyAgentIds((prev) => new Set(prev).add(agentId));
    try {
      const existing = assignments.find((a) => a.agentId === agentId);
      if (existing) {
        await apiFetch(`/api/agents/${agentId}/skills/${skillId}`, { method: "DELETE" });
        onAssignmentsChange(assignments.filter((a) => a.agentId !== agentId));
      } else {
        const pin = await apiFetch<{ skillVersionId: number }>(`/api/agents/${agentId}/skills`, {
          method: "POST",
          body: JSON.stringify({ skillId }),
        });
        const agentName = allAgents?.find((a) => a.id === agentId)?.name ?? "";
        onAssignmentsChange([
          ...assignments,
          { agentId, agentName, skillVersionId: pin.skillVersionId, version: currentVersionNumber ?? 0 },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    } finally {
      setBusyAgentIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }

  const items: MultiSelectItem[] = (allAgents ?? []).map((a) => {
    const assignment = assignments.find((x) => x.agentId === a.id);
    return {
      id: a.id,
      label: a.name,
      trailing: assignment ? <Badge>{`v${assignment.version}`}</Badge> : undefined,
    };
  });
  const selectedIds = new Set(assignments.map((a) => a.agentId));

  return (
    <div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      <MultiSelectCheckboxList
        items={items}
        selectedIds={selectedIds}
        onToggle={handleToggle}
        disabledIds={busyAgentIds}
        emptyMessage={t("skills.detail.noOrgAgents")}
      />
    </div>
  );
}
