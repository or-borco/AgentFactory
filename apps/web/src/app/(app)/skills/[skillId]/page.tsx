"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Skill, SkillVersion } from "@agentfactory/core";
import { Badge, Breadcrumb, Button, Card, TextInput, Textarea } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { relativeTime } from "@/lib/relative-time";
import { ArrowLeftIcon, EditIcon } from "@/lib/icons";
import { DeleteSkillButton } from "@/components/DeleteSkillButton";
import { SkillAgentsPicker, type SkillAssignment } from "@/components/SkillAgentsPicker";

interface DraftDetail {
  version: SkillVersion;
  instructions: string;
}

export default function SkillDetailPage() {
  const { skillId } = useParams<{ skillId: string }>();
  const { t } = useTranslation();
  const router = useRouter();

  const [skill, setSkill] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [assignments, setAssignments] = useState<SkillAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [editing, setEditing] = useState(false);
  const [startingDraft, setStartingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ skill, versions }, assignments] = await Promise.all([
        apiFetch<{ skill: Skill; versions: SkillVersion[] }>(`/api/skills/${skillId}`),
        apiFetch<SkillAssignment[]>(`/api/skills/${skillId}/assignments`),
      ]);
      setSkill(skill);
      setVersions(versions);
      setAssignments(assignments);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [skillId]);

  useEffect(() => {
    // Initial fetch on mount; load() is async, so any setState it makes lands in a later
    // microtask, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const draftVersion = versions.find((v) => !v.publishedAt);
  const currentVersion = versions.find((v) => v.id === skill?.currentVersionId);
  const sortedVersions = [...versions].sort((a, b) => b.version - a.version);

  async function openEditor() {
    setError(null);
    setStartingDraft(true);
    try {
      if (!draftVersion) {
        const created = await apiFetch<SkillVersion>(`/api/skills/${skillId}/versions`, { method: "POST" });
        setVersions((prev) => [...prev, created]);
      }
      const detail = await apiFetch<DraftDetail>(`/api/skills/${skillId}/draft`);
      setDraftName(detail.version.name);
      setDraftDescription(detail.version.description);
      setDraftInstructions(detail.instructions);
      setEditing(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    } finally {
      setStartingDraft(false);
    }
  }

  async function saveDraft() {
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<SkillVersion>(`/api/skills/${skillId}/draft`, {
        method: "PATCH",
        body: JSON.stringify({ name: draftName, description: draftDescription, instructions: draftInstructions }),
      });
      setVersions((prev) => prev.map((v) => (v.id === updated.id ? updated : v)));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setError(null);
    try {
      await apiFetch<void>(`/api/skills/${skillId}/draft/publish`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    } finally {
      setPublishing(false);
    }
  }

  if (loading) {
    return <div className="px-10 py-10 text-sm text-[var(--color-neutral-500)]">{t("common.loading")}</div>;
  }
  if (notFound || !skill) {
    return <div className="px-10 py-10 text-sm text-[var(--color-neutral-500)]">{t("skills.notFound")}</div>;
  }

  return (
    <div className="pb-16">
      <div className="px-10 pt-8">
        <Breadcrumb href="/skills" label={t("skills.title")} icon={<ArrowLeftIcon size={15} />} />
      </div>

      <div className="flex items-start justify-between gap-4 px-10 pt-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">{skill.name}</h1>
          <p className="mt-0.5 text-sm text-[var(--color-neutral-500)]">
            {currentVersion ? currentVersion.description : t("skills.detail.noPublishedVersion")}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={openEditor} disabled={startingDraft || editing}>
            <EditIcon size={14} />
            {startingDraft ? t("common.loading") : t("common.edit")}
          </Button>
          {draftVersion && !editing && (
            <Button onClick={publish} disabled={publishing}>
              {publishing ? t("skills.detail.publishing") : t("skills.detail.publish")}
            </Button>
          )}
          <DeleteSkillButton
            skillId={skill.id}
            skillName={skill.name}
            assignedAgentNames={assignments.map((a) => a.agentName)}
            onDeleted={() => router.push("/skills")}
            onError={setError}
          />
        </div>
      </div>

      {error && <p className="px-10 pt-3 text-xs text-red-400">{error}</p>}

      {editing && (
        <div className="px-10 pt-6">
          <Card className="space-y-4 p-5">
            <Field label={t("skills.create.nameLabel")}>
              <TextInput value={draftName} onChange={(e) => setDraftName(e.target.value)} />
            </Field>
            <Field label={t("skills.create.descriptionLabel")}>
              <Textarea rows={3} value={draftDescription} onChange={(e) => setDraftDescription(e.target.value)} />
            </Field>
            <Field label={t("skills.create.instructionsLabel")}>
              <Textarea rows={10} value={draftInstructions} onChange={(e) => setDraftInstructions(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" type="button" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={saveDraft} disabled={saving}>
                {saving ? t("skills.detail.savingDraft") : t("skills.detail.saveDraft")}
              </Button>
            </div>
          </Card>
        </div>
      )}

      <div className="px-10 pt-8">
        <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t("skills.detail.versionHistory")}</h2>
        <Card>
          <table className="w-full text-sm">
            <tbody>
              {sortedVersions.map((v, i) => (
                <tr
                  key={v.id}
                  className={i < sortedVersions.length - 1 ? "border-b border-[var(--color-divider)]" : ""}
                >
                  <td className="px-4 py-3 font-medium text-[var(--color-neutral-200)]">{`v${v.version}`}</td>
                  <td className="px-4 py-3 text-[var(--color-neutral-500)]">
                    {v.publishedAt ? relativeTime(v.publishedAt, t) : t("skills.detail.draftLabel")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {v.id === skill.currentVersionId && <Badge tone="success">{t("skills.detail.currentBadge")}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="px-10 pt-8">
        <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t("skills.detail.assignedAgents")}</h2>
        <SkillAgentsPicker
          skillId={skill.id}
          currentVersionNumber={currentVersion?.version}
          assignments={assignments}
          onAssignmentsChange={setAssignments}
        />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-[var(--color-neutral-400)]">{label}</label>
      {children}
    </div>
  );
}
