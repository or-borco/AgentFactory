"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { Button, Breadcrumb, PageHeader, TextInput, Textarea } from "@agentfactory/shared";
import { useMockBackend } from "@/lib/mock/context";
import { useTranslation } from "@/lib/i18n/context";

export default function NewTaskPage() {
  const router = useRouter();
  const { agents, createTask } = useMockBackend();
  const { t } = useTranslation();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteriaRaw, setCriteriaRaw] = useState("");
  const [assigneeAgentId, setAssigneeAgentId] = useState<number | undefined>(undefined);
  const [area, setArea] = useState("");
  const [codebase, setCodebase] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const acceptanceCriteria = criteriaRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((text) => ({ text, done: false }));

      const task = await createTask({
        title: title.trim(),
        description: description.trim(),
        acceptanceCriteria,
        assigneeAgentId,
        area: area.trim() || undefined,
        codebase: codebase.trim() || undefined,
      });
      router.push(`/tasks/${task.id}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: "40px 40px 0", maxWidth: 680 }}>
      <Breadcrumb label={t("tasks.title")} href="/tasks" />

      <div style={{ marginTop: 20 }}>
        <PageHeader title={t("tasks.create.title")} subtitle={t("tasks.create.subtitle")} />
      </div>

      <form onSubmit={handleSubmit} style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Title */}
        <Field label={t("tasks.create.titleLabel")}>
          <TextInput
            placeholder={t("tasks.create.titlePlaceholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </Field>

        {/* Description */}
        <Field label={t("tasks.create.descriptionLabel")}>
          <Textarea
            placeholder={t("tasks.create.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </Field>

        {/* Acceptance criteria */}
        <Field label={t("tasks.create.criteriaLabel")}>
          <Textarea
            placeholder={t("tasks.create.criteriaPlaceholder")}
            value={criteriaRaw}
            onChange={(e) => setCriteriaRaw(e.target.value)}
            rows={4}
          />
          <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>
            One criterion per line.
          </p>
        </Field>

        {/* Assignee */}
        <Field label={t("tasks.create.assigneeLabel")}>
          <select
            value={assigneeAgentId ?? ""}
            onChange={(e) => setAssigneeAgentId(e.target.value ? Number(e.target.value) : undefined)}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-neutral-700)",
              background: "var(--color-surface)",
              color: assigneeAgentId ? "var(--color-text)" : "var(--color-neutral-500)",
              fontSize: 13,
            }}
          >
            <option value="">{t("tasks.create.assigneePlaceholder")}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>

        {/* Area + codebase — side by side */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label={t("tasks.create.areaLabel")}>
            <TextInput
              placeholder={t("tasks.create.areaPlaceholder")}
              value={area}
              onChange={(e) => setArea(e.target.value)}
            />
          </Field>
          <Field label={t("tasks.create.codebaseLabel")}>
            <TextInput
              placeholder={t("tasks.create.codebasePlaceholder")}
              value={codebase}
              onChange={(e) => setCodebase(e.target.value)}
            />
          </Field>
        </div>

        {/* Context documents stub */}
        <Field label={t("tasks.create.contextLabel")}>
          <div
            style={{
              border: "1.5px dashed var(--color-neutral-700)",
              borderRadius: "var(--radius-md)",
              padding: "24px 20px",
              textAlign: "center",
              color: "var(--color-neutral-500)",
              fontSize: 13,
            }}
          >
            {t("tasks.create.contextNote")}
          </div>
        </Field>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, paddingBottom: 40 }}>
          <Button variant="primary" type="submit" disabled={!title.trim() || submitting}>
            {submitting ? "Creating…" : t("tasks.create.submit")}
          </Button>
          <Link href="/tasks">
            <Button variant="secondary" type="button">{t("tasks.create.cancel")}</Button>
          </Link>
        </div>
      </form>
    </div>
  );
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
