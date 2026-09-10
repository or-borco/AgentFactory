"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import type { Skill, SkillVersion } from "@agentfactory/core";
import { Breadcrumb, Button, PageHeader, TextInput, Textarea } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

export default function NewSkillPage() {
  const router = useRouter();
  const { t } = useTranslation();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !instructions.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { skill } = await apiFetch<{ skill: Skill; draft: SkillVersion }>("/api/skills", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
        }),
      });
      router.push(`/skills/${skill.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: "40px 40px 0", maxWidth: 680 }}>
      <Breadcrumb label={t("skills.title")} href="/skills" />

      <div style={{ marginTop: 20 }}>
        <PageHeader title={t("skills.create.title")} subtitle={t("skills.create.subtitle")} />
      </div>

      <form onSubmit={handleSubmit} style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 20 }}>
        <Field label={t("skills.create.nameLabel")}>
          <TextInput
            placeholder={t("skills.create.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>

        <Field label={t("skills.create.descriptionLabel")}>
          <Textarea
            placeholder={t("skills.create.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </Field>

        <Field label={t("skills.create.instructionsLabel")}>
          <Textarea
            placeholder={t("skills.create.instructionsPlaceholder")}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={10}
          />
          <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>
            {t("skills.create.instructionsHint")}
          </p>
        </Field>

        {error && <p style={{ fontSize: 12, color: "#e05252" }}>{error}</p>}

        <div style={{ display: "flex", gap: 10, paddingBottom: 40 }}>
          <Button variant="primary" type="submit" disabled={!name.trim() || !instructions.trim() || submitting}>
            {submitting ? t("skills.create.submitting") : t("skills.create.submit")}
          </Button>
          <Link href="/skills">
            <Button variant="secondary" type="button">
              {t("skills.create.cancel")}
            </Button>
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
