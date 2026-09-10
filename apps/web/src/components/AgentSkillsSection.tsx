"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Skill, SkillVersion } from "@agentfactory/core";
import { Badge, Card } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { TrashIcon } from "@/lib/icons";

// Mirrors the AgentSkillSummary shape returned by GET /api/agents/[agentId]/skills
// (packages/db/src/repositories/agent-skills.ts) — kept local rather than imported from
// @agentfactory/db since client components only pull domain shapes from @agentfactory/core.
interface AssignedSkill {
  agentId: number;
  skillId: number;
  skillVersionId: number;
  skillName: string;
  skillSlug: string;
  version: number;
}

export function AgentSkillsSection({ agentId }: { agentId: number }) {
  const { t } = useTranslation();
  const [assigned, setAssigned] = useState<AssignedSkill[] | null>(null);
  const [allSkills, setAllSkills] = useState<Skill[] | null>(null);
  const [versionsBySkill, setVersionsBySkill] = useState<Record<number, SkillVersion[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<number | null>(null);

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

  async function handleAdd(skillId: number) {
    if (!skillId) return;
    setError(null);
    try {
      await apiFetch(`/api/agents/${agentId}/skills`, { method: "POST", body: JSON.stringify({ skillId }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    }
  }

  async function handleUpgrade(skillId: number, skillVersionId: number) {
    setBusySkillId(skillId);
    setError(null);
    try {
      await apiFetch(`/api/agents/${agentId}/skills/${skillId}`, {
        method: "PATCH",
        body: JSON.stringify({ skillVersionId }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    } finally {
      setBusySkillId(null);
    }
  }

  async function handleRemove(skillId: number) {
    setBusySkillId(skillId);
    setError(null);
    try {
      await apiFetch(`/api/agents/${agentId}/skills/${skillId}`, { method: "DELETE" });
      setAssigned((prev) => prev?.filter((a) => a.skillId !== skillId) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    } finally {
      setBusySkillId(null);
    }
  }

  const assignedIds = new Set((assigned ?? []).map((a) => a.skillId));
  const assignableSkills = (allSkills ?? []).filter((s) => !assignedIds.has(s.id));

  return (
    <div className="px-10 pt-8">
      <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t("agents.skills.title")}</h2>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {assigned && assigned.length === 0 ? (
        <Card className="mb-3 px-5 py-6 text-center text-sm text-[var(--color-neutral-500)]">
          {t("agents.skills.emptyState")}
        </Card>
      ) : (
        <div className="mb-3 space-y-2">
          {(assigned ?? []).map((a) => (
            <Card key={a.skillId} className="flex items-center justify-between gap-3 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <Link
                  href={`/skills/${a.skillId}`}
                  className="truncate text-sm font-medium text-[var(--color-text)] hover:underline"
                >
                  {a.skillName}
                </Link>
                <Badge>{`v${a.version}`}</Badge>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  aria-label={t("agents.skills.versionLabel")}
                  value={a.skillVersionId}
                  disabled={busySkillId === a.skillId}
                  onChange={(e) => handleUpgrade(a.skillId, Number(e.target.value))}
                  style={{
                    padding: "3px 6px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--color-neutral-700)",
                    background: "var(--color-surface)",
                    color: "var(--color-text)",
                    fontSize: 13,
                  }}
                >
                  {(versionsBySkill[a.skillId] ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {`v${v.version}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={t("agents.skills.removeButtonLabel")}
                  disabled={busySkillId === a.skillId}
                  onClick={() => handleRemove(a.skillId)}
                  className="flex items-center justify-center text-[var(--color-neutral-500)] hover:text-red-400"
                  style={{ padding: 4 }}
                >
                  <TrashIcon size={15} />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <label htmlFor="add-skill-select" className="text-xs font-medium text-[var(--color-neutral-400)]">
          {t("agents.skills.addLabel")}
        </label>
        <select
          id="add-skill-select"
          aria-label={t("agents.skills.addLabel")}
          value=""
          disabled={assignableSkills.length === 0}
          onChange={(e) => {
            const skillId = Number(e.target.value);
            e.target.value = "";
            handleAdd(skillId);
          }}
          style={{
            padding: "3px 6px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--color-neutral-700)",
            background: "var(--color-surface)",
            color: "var(--color-text)",
            fontSize: 13,
          }}
        >
          <option value="" disabled>
            {assignableSkills.length === 0 ? t("agents.skills.noAssignableSkills") : t("agents.skills.addPlaceholder")}
          </option>
          {assignableSkills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.currentVersionId ? s.name : `${s.name} (${t("skills.draftOnlyBadge")})`}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
