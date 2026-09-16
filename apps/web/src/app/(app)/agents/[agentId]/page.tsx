"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AgentFormModal, type AgentFormValues } from "@/components/AgentFormModal";
import { AgentSkillsSection } from "@/components/AgentSkillsSection";
import { Badge, Breadcrumb, Button, Card, CardLink, Truncate } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { ArrowLeftIcon, ChatIcon, PlusIcon, SettingsIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";
import { relativeTime } from "@/lib/relative-time";

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { getAgent, sessionsForAgent, updateAgent, createSession } = useMockBackend();
  const { t } = useTranslation();
  const [showEdit, setShowEdit] = useState(false);
  const router = useRouter();

  const agent = getAgent(Number(agentId));
  if (!agent) {
    return <div className="px-10 py-10 text-sm text-[var(--color-neutral-500)]">{t("common.loading")}</div>;
  }
  const sessions = sessionsForAgent(agent.id);

  return (
    <div className="pb-16">
      <div className="px-10 pt-8">
        <Breadcrumb href="/teams-v2" label={t("nav.teams")} icon={<ArrowLeftIcon size={15} />} />
      </div>

      <div className="flex items-start justify-between px-10 pt-4">
        <div className="flex min-w-0 items-start gap-4">
          <div
            className="flex shrink-0 items-center justify-center bg-[var(--color-accent-800)] border border-[var(--color-accent-600)] text-2xl"
            style={{ width: 52, height: 52, borderRadius: "var(--radius-md)" }}
          >
            {agent.avatarEmoji}
          </div>
          <div className="min-w-0">
            <Truncate as="h1" text={agent.name} className="text-xl font-semibold text-[var(--color-text)]" />
            <p className="mt-0.5 text-sm text-[var(--color-neutral-500)]">{agent.description}</p>
            {agent.mode === "automatic" && (
              <div className="mt-2">
                <Badge>{t("common.automatic")}</Badge>
              </div>
            )}
          </div>
        </div>
        <Button variant="secondary" onClick={() => setShowEdit(true)}>
          <SettingsIcon size={14} />
          {t("common.edit")}
        </Button>
      </div>

      <div className="px-10 pt-8">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
          {t("agents.systemPrompt")}
        </p>
        <Card className="p-4 text-sm text-[var(--color-neutral-400)]">
          <pre style={{ margin: 0, fontFamily: "inherit", fontSize: "inherit", whiteSpace: "pre-wrap", lineHeight: 1.7, color: "inherit" }}>{agent.systemPrompt}</pre>
        </Card>
      </div>

      <AgentSkillsSection agentId={agent.id} />

      <div className="px-10 pt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--color-text)]">{t("agents.sessions")}</h2>
          <Button
            onClick={async () => {
              const session = await createSession(agent.id, t("agents.newSessionDefaultTitle"));
              router.push(`/sessions/${session.id}`);
            }}
          >
            <PlusIcon size={15} />
            {t("agents.newSession")}
          </Button>
        </div>

        {sessions.length === 0 ? (
          <Card className="px-5 py-10 text-center text-sm text-[var(--color-neutral-500)]">
            {t("agents.noSessionsYet")}
          </Card>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => (
              <CardLink key={session.id} href={`/sessions/${session.id}`} className="flex items-center justify-between px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <ChatIcon size={15} style={{ flexShrink: 0, color: "var(--color-neutral-500)" }} />
                  <Truncate text={session.title} className="text-sm font-medium text-[var(--color-text)]" wrapperClassName="min-w-0 flex-1" />
                </div>
                <span className="shrink-0 text-xs text-[var(--color-neutral-500)]">{relativeTime(session.lastActivityAt, t)}</span>
              </CardLink>
            ))}
          </div>
        )}
      </div>

      {showEdit && (
        <AgentFormModal
          title={t("agentForm.editTitle")}
          submitLabel={t("agentForm.saveSubmit")}
          initial={{
            name: agent.name,
            description: agent.description ?? "",
            systemPrompt: agent.systemPrompt,
            mode: agent.mode,
            defaultCodebase: agent.defaultCodebase ?? "",
          }}
          onClose={() => setShowEdit(false)}
          onSubmit={async (values: AgentFormValues) => {
            await updateAgent(agent.id, values);
            setShowEdit(false);
          }}
        />
      )}
    </div>
  );
}
