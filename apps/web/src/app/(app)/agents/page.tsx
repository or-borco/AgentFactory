"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AgentFormModal, type AgentFormValues } from "@/components/AgentFormModal";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { ArrowRightIcon, PlusIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";

export default function AgentsPage() {
  const { agents, createAgent } = useMockBackend();
  const [showNew, setShowNew] = useState(false);
  const router = useRouter();

  const handleCreate = (values: AgentFormValues) => {
    const agent = createAgent(values);
    setShowNew(false);
    router.push(`/agents/${agent.id}`);
  };

  return (
    <div className="pb-16">
      <PageHeader
        title="Agents"
        subtitle="Shared AI agents for your engineering team"
        action={
          <Button onClick={() => setShowNew(true)}>
            <PlusIcon className="h-4 w-4" />
            New agent
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 px-10 pt-8 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <Link key={agent.id} href={`/agents/${agent.id}`}>
            <Card className="p-5 transition-shadow hover:shadow-md">
              <div className="mb-4 flex items-start justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl">
                  {agent.avatarEmoji}
                </div>
                <ArrowRightIcon className="h-4 w-4 text-slate-300" />
              </div>
              <h3 className="font-semibold text-slate-900">{agent.name}</h3>
              <p className="mt-1 text-sm text-slate-500">{agent.description}</p>
              {agent.mode === "automatic" && (
                <div className="mt-3">
                  <Badge>Automatic</Badge>
                </div>
              )}
            </Card>
          </Link>
        ))}
      </div>

      {showNew && (
        <AgentFormModal
          title="New agent"
          submitLabel="Create agent"
          onClose={() => setShowNew(false)}
          onSubmit={handleCreate}
        />
      )}
    </div>
  );
}
