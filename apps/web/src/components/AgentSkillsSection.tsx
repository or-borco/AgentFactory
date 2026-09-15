"use client";

import { AgentSkillsPicker } from "@/components/AgentSkillsPicker";
import { useTranslation } from "@/lib/i18n/context";

export function AgentSkillsSection({ agentId }: { agentId: number }) {
  const { t } = useTranslation();
  return (
    <div className="px-10 pt-8">
      <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t("agents.skills.title")}</h2>
      <AgentSkillsPicker agentId={agentId} />
    </div>
  );
}
