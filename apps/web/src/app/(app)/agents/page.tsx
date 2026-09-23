"use client";

import type { Agent } from "@agentfactory/core";
import { Badge, CardLink, EmptyState, PageHeader, Truncate } from "@agentfactory/shared";
import { useAppData } from "@/lib/app-data/context";
import { useTranslation } from "@/lib/i18n/context";
import { BotIcon } from "@/lib/icons";

function AgentCard({ agent, t }: { agent: Agent; t: ReturnType<typeof useTranslation>["t"] }) {
  return (
    <CardLink href={`/agents/${agent.id}`} className="p-4">
      <div className="flex items-start gap-3">
        <span className="shrink-0 text-2xl leading-none">{agent.avatarEmoji ?? "🤖"}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Truncate as="h3" text={agent.name} className="text-sm font-semibold text-[var(--color-text)]" />
            {agent.mode === "automatic" && <Badge tone="success">{t("common.automatic")}</Badge>}
          </div>
          {agent.description && (
            <p className="mt-1.5 line-clamp-2 text-xs text-[var(--color-neutral-500)]">{agent.description}</p>
          )}
        </div>
      </div>
    </CardLink>
  );
}

export default function AgentsPage() {
  const { t } = useTranslation();
  const { agents, teams } = useAppData();

  const groups: Array<{ key: string; label: string; agents: Agent[] }> = [];
  for (const team of teams) {
    const teamAgents = agents.filter((agent) => agent.teamId === team.id);
    if (teamAgents.length > 0) groups.push({ key: String(team.id), label: team.name, agents: teamAgents });
  }
  const noTeamAgents = agents.filter((agent) => agent.teamId == null);
  if (noTeamAgents.length > 0) {
    groups.push({ key: "no-team", label: t("agents.noTeamGroup"), agents: noTeamAgents });
  }

  return (
    <div style={{ padding: "40px 40px 0" }}>
      <PageHeader title={t("agents.title")} subtitle={t("agents.subtitle")} />

      {agents.length === 0 ? (
        <EmptyState
          icon={<BotIcon size={22} />}
          title={t("agents.emptyState.title")}
          subtitle={t("agents.emptyState.body")}
        />
      ) : (
        <div className="pb-16">
          {groups.map((group) => (
            <section key={group.key} className="mt-6">
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-neutral-500)]">
                {group.label}
                <Badge>{group.agents.length}</Badge>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.agents.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} t={t} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
