"use client";

import { useEffect, useState } from "react";
import { Button, Card, TextInput } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

interface RepoOption {
  id: string;
  fullName: string;
  provider: string;
}

interface CodebaseSettings {
  repoFullName: string;
  setupCommand: string | null;
}

function CodebaseSetupRow({ repoFullName, savedCommand }: { repoFullName: string; savedCommand: string }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(savedCommand);
  const [draft, setDraft] = useState(savedCommand);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const result = await apiFetch<CodebaseSettings>("/api/codebases/settings", {
        method: "PUT",
        body: JSON.stringify({ repoFullName, setupCommand: draft.trim() || null }),
      });
      const next = result.setupCommand ?? "";
      setSaved(next);
      setDraft(next);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("settings.codebaseSetup.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const inputId = `setup-command-${repoFullName}`;

  return (
    <form onSubmit={save} className="px-5 py-4">
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-semibold text-[var(--color-text)]">
        {repoFullName}
      </label>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <TextInput
            id={inputId}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setJustSaved(false);
            }}
            placeholder={t("settings.codebaseSetup.placeholder")}
            className="font-mono"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={saving || draft.trim() === saved}>
          {saving ? t("settings.codebaseSetup.saving") : t("settings.codebaseSetup.save")}
        </Button>
      </div>
      {error && <p className="mt-1.5 text-xs text-[var(--color-danger)]">{error}</p>}
      {justSaved && !error && (
        <p className="mt-1.5 text-xs text-[var(--color-neutral-500)]">{t("settings.codebaseSetup.saved")}</p>
      )}
    </form>
  );
}

export function CodebaseSetupSettings() {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<RepoOption[] | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<RepoOption[]>("/api/connections/repos"),
      apiFetch<CodebaseSettings[]>("/api/codebases/settings"),
    ])
      .then(([repoList, settingsList]) => {
        if (cancelled) return;
        setRepos(repoList);
        setSettings(
          Object.fromEntries(settingsList.map((entry) => [entry.repoFullName, entry.setupCommand ?? ""])),
        );
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <h2 className="mb-1 text-base font-semibold text-[var(--color-text)]">{t("settings.codebaseSetup.heading")}</h2>
      <p className="mb-3 text-xs text-[var(--color-neutral-500)]">{t("settings.codebaseSetup.help")}</p>
      {loadFailed ? (
        <Card className="px-5 py-4 text-sm text-[var(--color-danger)]">{t("settings.codebaseSetup.loadFailed")}</Card>
      ) : repos === null ? (
        <Card className="px-5 py-4 text-sm text-[var(--color-neutral-500)]">{t("settings.codebaseSetup.loading")}</Card>
      ) : repos.length === 0 ? (
        <Card className="px-5 py-4 text-sm text-[var(--color-neutral-500)]">{t("settings.codebaseSetup.empty")}</Card>
      ) : (
        <Card className="divide-y divide-[var(--color-divider)]">
          {repos.map((repo) => (
            <CodebaseSetupRow
              key={`${repo.provider}:${repo.id}`}
              repoFullName={repo.fullName}
              savedCommand={settings[repo.fullName] ?? ""}
            />
          ))}
        </Card>
      )}
    </>
  );
}
