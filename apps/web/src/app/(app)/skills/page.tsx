"use client";

import { Badge, Button, Card, PageHeader } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { PlusIcon, SparklesIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";

export default function SkillsPage() {
  const { skills, notify } = useMockBackend();
  const { t } = useTranslation();

  return (
    <div className="pb-16">
      <PageHeader
        title={t("skills.title")}
        subtitle={t("skills.subtitle")}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => notify("toast.importFromGitComingSoon")}>
              {t("skills.importFromGit")}
            </Button>
            <Button onClick={() => notify("toast.skillAuthoringComingSoon")}>
              <PlusIcon size={15} />
              {t("skills.newSkill")}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-10 pt-8 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((skill) => (
          <Card key={skill.id} className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div
                className="flex items-center justify-center bg-[var(--color-accent-800)] border border-[var(--color-accent-600)] text-[var(--color-accent)]"
                style={{ width: 40, height: 40, borderRadius: "var(--radius-md)" }}
              >
                <SparklesIcon size={18} />
              </div>
              <Badge tone={skill.source === "git" ? "success" : "neutral"}>
                {skill.source === "git" ? t("skills.sourceGit") : t("skills.sourceAuthored")}
              </Badge>
            </div>
            <h3 className="font-semibold text-[var(--color-text)]">{skill.name}</h3>
            <p className="mt-1 text-sm text-[var(--color-neutral-500)]">{skill.description}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
