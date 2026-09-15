"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/Modal";
import { Button, GroupedSelect, Textarea, TextInput } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { AgentMode } from "@agentfactory/core";
import type { RepoOption } from "@agentfactory/scm";

export interface AgentFormValues {
  name: string;
  description: string;
  systemPrompt: string;
  mode: AgentMode;
  defaultCodebase?: string;
}

export function AgentFormModal({
  title,
  submitLabel,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: Partial<AgentFormValues>;
  onClose: () => void;
  onSubmit: (values: AgentFormValues) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [mode, setMode] = useState<AgentMode>(initial?.mode ?? "manual");
  const [defaultCodebase, setDefaultCodebase] = useState(initial?.defaultCodebase ?? "");
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<RepoOption[]>("/api/connections/repos")
      .then((result) => {
        if (!cancelled) setRepos(result);
      })
      .finally(() => {
        if (!cancelled) setReposLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The agent's existing default might point at a repo that's no longer connected (or was set
  // before this field became a dropdown) — keep it selectable instead of silently discarding it.
  const hasCurrentRepo = !defaultCodebase || repos.some((repo) => repo.fullName === defaultCodebase);

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !systemPrompt.trim()) return;
          onSubmit({
            name: name.trim(),
            description: description.trim(),
            systemPrompt: systemPrompt.trim(),
            mode,
            defaultCodebase: defaultCodebase.trim() || undefined,
          });
        }}
      >
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
            {t("agentForm.nameLabel")}
          </label>
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("agentForm.namePlaceholder")}
            maxLength={80}
            required
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
            {t("agentForm.descriptionLabel")}
          </label>
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("agentForm.descriptionPlaceholder")}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
            {t("agentForm.systemPromptLabel")}
          </label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={4}
            placeholder={t("agentForm.systemPromptPlaceholder")}
            required
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
            {t("agentForm.defaultCodebaseLabel")}
          </label>
          <GroupedSelect
            value={defaultCodebase}
            onChange={setDefaultCodebase}
            className="w-full rounded-[var(--radius-md)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-3 py-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
            placeholder={reposLoading ? t("agentForm.defaultCodebaseLoading") : t("agentForm.defaultCodebasePlaceholder")}
            extraOptions={hasCurrentRepo ? [] : [{ key: defaultCodebase, value: defaultCodebase, label: defaultCodebase }]}
            options={repos.map((repo) => ({
              key: repo.id,
              value: repo.fullName,
              label: repo.fullName,
              group: repo.provider,
            }))}
            groupLabel={(provider) => t(`connections.provider.${provider}`)}
          />
          <p className="mt-1.5 text-xs text-[var(--color-neutral-600)]">{t("agentForm.defaultCodebaseHelp")}</p>
          {!reposLoading && repos.length === 0 && (
            <p className="mt-1.5 text-xs text-[var(--color-neutral-600)]">
              {t("agentForm.defaultCodebaseEmpty")}{" "}
              <Link href="/connections" className="text-[var(--color-accent-2)]">
                {t("agentForm.defaultCodebaseEmptyLink")}
              </Link>
            </p>
          )}
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
            {t("agentForm.modeLabel")}
          </label>
          <div className="flex gap-2">
            {(["manual", "automatic"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-[var(--radius-sm)] border px-3 py-2 text-sm font-medium transition-colors ${
                  mode === m
                    ? "border-[var(--color-accent-600)] bg-[var(--color-accent-900)] text-[var(--color-accent-300)]"
                    : "border-[var(--color-divider)] text-[var(--color-neutral-400)] hover:border-[var(--color-neutral-600)] hover:text-[var(--color-neutral-200)]"
                }`}
              >
                {m === "manual" ? t("agentForm.modeManual") : t("agentForm.modeAutomatic")}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-[var(--color-neutral-600)]">
            {mode === "manual" ? t("agentForm.modeManualHelp") : t("agentForm.modeAutomaticHelp")}
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit">{submitLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}
