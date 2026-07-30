"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AgentFormModal, type AgentFormValues } from "@/components/AgentFormModal";
import { Badge, Button, CardLink, PageHeader, Truncate } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { ArrowRightIcon, PlusIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";

export default function AgentsPage() {
  const { agents, createAgent } = useMockBackend();
  const { t } = useTranslation();
  const [showNew, setShowNew] = useState(false);
  const router = useRouter();

  const handleCreate = async (values: AgentFormValues) => {
    const agent = await createAgent(values);
    setShowNew(false);
    router.push(`/agents/${agent.id}`);
  };

  return (
    <div className="pb-16">
      <PageHeader
        title={t("agents.title")}
        subtitle={t("agents.subtitle")}
        action={
          <Button onClick={() => setShowNew(true)}>
            <PlusIcon size={15} />
            {t("agents.newAgent")}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-10 pt-8 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <CardLink key={agent.id} href={`/agents/${agent.id}`} className="p-5">
            <div className="mb-4 flex items-start justify-between">
              <div
                className="flex items-center justify-center bg-[var(--color-accent-800)] border border-[var(--color-accent-600)] text-xl"
                style={{ width: 40, height: 40, borderRadius: "var(--radius-md)" }}
              >
                {agent.avatarEmoji}
              </div>
              <ArrowRightIcon size={15} style={{ color: "var(--color-neutral-600)" }} />
            </div>
            <Truncate as="h3" text={agent.name} className="font-semibold text-[var(--color-text)]" />
            <p className="mt-1 text-sm text-[var(--color-neutral-500)]">{agent.description}</p>
            {/* Reserve badge height on every card for consistent grid row heights */}
            <div className="mt-3 h-6">
              {agent.mode === "automatic" && <Badge>{t("common.automatic")}</Badge>}
            </div>
          </CardLink>
        ))}
      </div>

      {showNew && (
        <AgentFormModal
          title={t("agentForm.newTitle")}
          submitLabel={t("agentForm.createSubmit")}
          onClose={() => setShowNew(false)}
          onSubmit={handleCreate}
        />
      )}
    </div>
  );
}
