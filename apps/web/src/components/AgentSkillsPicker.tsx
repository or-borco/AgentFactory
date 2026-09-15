"use client";

import { useCallback, useEffect, useState } from "react";
import type { Skill, SkillVersion } from "@agentfactory/core";
import { Badge, MultiSelectCheckboxList, type MultiSelectItem } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

// Mirrors the AgentSkillSummary shape returned by GET /api/agents/[agentId]/skills
// (packages/db/src/repositories/agent-skills.ts). Kept local rather than imported from
// @agentfactory/db since client components only pull domain shapes from @agentfactory/core.
interface AssignedSkill {
  agentId: number;
  skillId: number;
  skillVersionId: number;
  skillName: string;
  skillSlug: string;
  version: number;
}

export function AgentSkillsPicker({ agentId }: { agentId: number }) {
  const { t } = useTranslation();
  const [assigned, setAssigned] = useState<AssignedSkill[] | null>(null);
  const [allSkills, setAllSkills] = useState<Skill[] | null>(null);
  const [versionsBySkill, setVersionsBySkill] = useState<Record<number, SkillVersion[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busySkillIds, setBusySkillIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const [assignedSkills, skills] = await Promise.all([
        apiFetch<AssignedSkill[]>(`/api/agents/${agentId}/skills`),
        apiFetch<Skill[]>("/api/skills"),
      ]);
      setAssigned(assignedSkills);
      setAllSkills(skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    }
  }, [agentId, t]);

  useEffect(() => {
    // Initial fetch on mount; load() is async, so any setState it makes lands in a later
    // microtask, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Populates the per-row upgrade dropdown: for every assigned skill, fetch that skill's
  // published versions. Runs whenever the assigned list changes (add/remove/upgrade).
  useEffect(() => {
    if (!assigned || assigned.length === 0) return;
    let cancelled = false;
    Promise.all(
      assigned.map(async (a) => {
        const detail = await apiFetch<{ skill: Skill; versions: SkillVersion[] }>(`/api/skills/${a.skillId}`);
        return [a.skillId, detail.versions.filter((v) => v.publishedAt)] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setVersionsBySkill(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [assigned]);

  function withBusy(skillId: number, fn: () => Promise<void>) {
    setError(null);
    setBusySkillIds((prev) => new Set(prev).add(skillId));
    return fn()
      .catch((err) => setError(err instanceof Error ? err.message : t("common.loadError")))
      .finally(() =>
        setBusySkillIds((prev) => {
          const next = new Set(prev);
          next.delete(skillId);
          return next;
        }),
      );
  }

  function handleToggle(skillId: number) {
    const isAssigned = (assigned ?? []).some((a) => a.skillId === skillId);
    return withBusy(skillId, async () => {
      if (isAssigned) {
        await apiFetch(`/api/agents/${agentId}/skills/${skillId}`, { method: "DELETE" });
        setAssigned((prev) => prev?.filter((a) => a.skillId !== skillId) ?? null);
      } else {
        await apiFetch(`/api/agents/${agentId}/skills`, { method: "POST", body: JSON.stringify({ skillId }) });
        await load();
      }
    });
  }

  function handleUpgrade(skillId: number, skillVersionId: number) {
    return withBusy(skillId, async () => {
      await apiFetch(`/api/agents/${agentId}/skills/${skillId}`, {
        method: "PATCH",
        body: JSON.stringify({ skillVersionId }),
      });
      await load();
    });
  }

  const assignedById = new Map((assigned ?? []).map((a) => [a.skillId, a]));

  const items: MultiSelectItem[] = (allSkills ?? []).map((s) => {
    const a = assignedById.get(s.id);
    if (a) {
      return {
        id: s.id,
        label: s.name,
        trailing: (
          <div className="flex items-center gap-2">
            <Badge>{`v${a.version}`}</Badge>
            <select
              aria-label={t("agents.skills.versionLabel")}
              value={a.skillVersionId}
              disabled={busySkillIds.has(s.id)}
              onChange={(e) => handleUpgrade(s.id, Number(e.target.value))}
              style={{
                padding: "3px 6px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-neutral-700)",
                background: "var(--color-surface)",
                color: "var(--color-text)",
                fontSize: 13,
              }}
            >
              {(versionsBySkill[s.id] ?? []).map((v) => (
                <option key={v.id} value={v.id}>{`v${v.version}`}</option>
              ))}
            </select>
          </div>
        ),
      };
    }
    return { id: s.id, label: s.name, sublabel: s.currentVersionId ? undefined : t("skills.draftOnlyBadge") };
  });

  const selectedIds = new Set((assigned ?? []).map((a) => a.skillId));
  const draftOnlyIds = (allSkills ?? []).filter((s) => !s.currentVersionId).map((s) => s.id);
  const disabledIds = new Set([...busySkillIds, ...draftOnlyIds]);

  return (
    <div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {allSkills === null ? (
        <p className="text-sm text-[var(--color-neutral-500)]">{t("common.loading")}</p>
      ) : (
        <MultiSelectCheckboxList
          items={items}
          selectedIds={selectedIds}
          onToggle={handleToggle}
          disabledIds={disabledIds}
          emptyMessage={t("agents.skills.emptyState")}
        />
      )}
    </div>
  );
}
