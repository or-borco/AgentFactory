"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Breadcrumb, PageHeader, TextInput, Textarea } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useMockBackend } from "@/lib/mock/context";
import { useTranslation } from "@/lib/i18n/context";
import { useRepoMapWaitGate } from "@/lib/use-repo-map-wait-gate";
import { RepoMapWaitBanner } from "@/components/RepoMapWaitBanner";

interface RepoOption {
  id: number;
  fullName: string;
}

export default function EditTaskPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const router = useRouter();
  const { getTask, updateTask } = useMockBackend();
  const { t } = useTranslation();

  const task = getTask(Number(taskId));

  const [description, setDescription] = useState("");
  const [criteriaRaw, setCriteriaRaw] = useState("");
  const [area, setArea] = useState("");
  const [codebase, setCodebase] = useState("");
  const [initializedForTaskId, setInitializedForTaskId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(true);

  // Pre-fill the form once the task loads, without a `useEffect` (which would call setState
  // synchronously in an effect body, a pattern this project's lint config flags). Adjusting
  // state directly in the render body when a dependency changes is React's own recommended
  // alternative — see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  if (task && initializedForTaskId !== task.id) {
    setInitializedForTaskId(task.id);
    setDescription(task.description);
    setCriteriaRaw(task.acceptanceCriteria.map((c) => c.text).join("\n"));
    setArea(task.area ?? "");
    setCodebase(task.codebase ?? "");
  }

  // Editing only makes sense before a session exists — once one does, the spec was
  // already handed to it, so bounce back to the read-only detail page.
  useEffect(() => {
    if (task?.sessionId) router.replace(`/tasks/${task.id}`);
  }, [task, router]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<RepoOption[]>("/api/connections/github/repos")
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

  async function doSubmit() {
    if (!task) return;
    setSubmitting(true);
    try {
      const acceptanceCriteria = criteriaRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((text) => {
          const existing = task.acceptanceCriteria.find((c) => c.text === text);
          return { text, done: existing?.done ?? false };
        });

      await updateTask(task.id, {
        description: description.trim(),
        acceptanceCriteria,
        area: area.trim() || null,
        codebase: codebase || null,
      });
      router.push(`/tasks/${task.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  const gate = useRepoMapWaitGate(codebase, () => void doSubmit());
  const gateBlocking = gate.state === "checking" || gate.state === "prompt" || gate.state === "waiting";

  if (!task) {
    return <div style={{ padding: "40px", color: "var(--color-neutral-500)" }}>Task not found.</div>;
  }

  // The repo-map check runs on the submit *attempt* — the gate calls doSubmit() via onProceed,
  // either immediately or once the user has made their wait/start-now choice. Opening this page
  // with an unmapped repo selected must not put a banner up before the user asks to save.
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (gateBlocking) return;
    gate.requestSubmit();
  }

  return (
    <div style={{ padding: "40px 40px 0", maxWidth: 680 }}>
      <Breadcrumb label={task.ref} href={`/tasks/${task.id}`} />

      <div style={{ marginTop: 20 }}>
        <PageHeader title={t("tasks.edit.title")} subtitle={t("tasks.edit.subtitle")} />
      </div>

      <form onSubmit={handleSubmit} style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 20 }}>
        <Field label={t("tasks.create.descriptionLabel")}>
          <Textarea
            placeholder={t("tasks.create.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </Field>

        <Field label={t("tasks.create.criteriaLabel")}>
          <Textarea
            placeholder={t("tasks.create.criteriaPlaceholder")}
            value={criteriaRaw}
            onChange={(e) => setCriteriaRaw(e.target.value)}
            rows={4}
          />
          <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>{t("tasks.create.criteriaHint")}</p>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label={t("tasks.create.areaLabel")}>
            <TextInput
              placeholder={t("tasks.create.areaPlaceholder")}
              value={area}
              onChange={(e) => setArea(e.target.value)}
            />
          </Field>
          <Field label={t("tasks.create.codebaseLabel")}>
            <select value={codebase} onChange={(e) => setCodebase(e.target.value)} style={selectStyle(!!codebase)}>
              <option value="">
                {reposLoading ? t("tasks.create.codebaseLoading") : t("tasks.create.codebasePlaceholder")}
              </option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </select>
            {!reposLoading && repos.length === 0 && (
              <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>
                {t("tasks.create.codebaseEmpty")}{" "}
                <Link href="/connections" style={{ color: "var(--color-accent-2)" }}>
                  {t("tasks.create.codebaseEmptyLink")}
                </Link>
              </p>
            )}
          </Field>
        </div>

        <RepoMapWaitBanner gate={gate} submitVerb="save" />

        <div style={{ display: "flex", gap: 10, paddingBottom: 40 }}>
          <Button variant="primary" type="submit" disabled={submitting || gateBlocking}>
            {submitting ? t("tasks.edit.saving") : t("tasks.edit.submit")}
          </Button>
          <Link href={`/tasks/${task.id}`}>
            <Button variant="secondary" type="button">
              {t("tasks.create.cancel")}
            </Button>
          </Link>
        </div>
      </form>
    </div>
  );
}

function selectStyle(hasValue: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--color-neutral-700)",
    background: "var(--color-surface)",
    color: hasValue ? "var(--color-text)" : "var(--color-neutral-500)",
    fontSize: 13,
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: "var(--color-neutral-300)", letterSpacing: "0.01em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}
