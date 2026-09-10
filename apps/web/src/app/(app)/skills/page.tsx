"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Skill } from "@agentfactory/core";
import { Badge, Button, CardLink, EmptyState, PageHeader } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { SparklesIcon } from "@/lib/icons";

function formatFamily(family: string): string {
  return family
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function SkillCard({ skill, t }: { skill: Skill; t: ReturnType<typeof useTranslation>["t"] }) {
  return (
    <CardLink href={`/skills/${skill.id}`} className="p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-[var(--color-text)]">{skill.name}</h3>
        <Badge tone={skill.currentVersionId ? "success" : "warning"}>
          {skill.currentVersionId ? t("skills.publishedBadge") : t("skills.draftOnlyBadge")}
        </Badge>
      </div>
      {skill.description && (
        <p className="mt-1.5 line-clamp-2 text-xs text-[var(--color-neutral-500)]">{skill.description}</p>
      )}
    </CardLink>
  );
}

export default function SkillsPage() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Skill[]>("/api/skills").then((result) => {
      if (!cancelled) setSkills(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const families = new Map<string, Skill[]>();
  const ungrouped: Skill[] = [];
  for (const skill of skills ?? []) {
    if (skill.family) {
      const group = families.get(skill.family);
      if (group) group.push(skill);
      else families.set(skill.family, [skill]);
    } else {
      ungrouped.push(skill);
    }
  }

  return (
    <div style={{ padding: "40px 40px 0" }}>
      <PageHeader
        title={t("skills.title")}
        subtitle={t("skills.subtitle")}
        action={
          <Link href="/skills/new">
            <Button variant="primary">{t("skills.newButton")}</Button>
          </Link>
        }
      />

      {skills === null ? (
        <div className="pt-10 text-sm text-[var(--color-neutral-500)]">{t("common.loading")}</div>
      ) : skills.length === 0 ? (
        <EmptyState
          icon={<SparklesIcon size={22} />}
          title={t("skills.emptyState.title")}
          subtitle={t("skills.emptyState.body")}
          action={
            <Link href="/skills/new">
              <Button variant="primary">{t("skills.newButton")}</Button>
            </Link>
          }
        />
      ) : (
        <div className="pb-16">
          {[...families.entries()].map(([family, familySkills]) => (
            <section key={family} className="mt-6">
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-neutral-500)]">
                {formatFamily(family)}
                <Badge>{familySkills.length}</Badge>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {familySkills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} t={t} />
                ))}
              </div>
            </section>
          ))}

          {ungrouped.length > 0 && (
            <section className="mt-6">
              {families.size > 0 && (
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-neutral-500)]">
                  {t("skills.otherSkillsHeading")}
                </h2>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {ungrouped.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} t={t} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
