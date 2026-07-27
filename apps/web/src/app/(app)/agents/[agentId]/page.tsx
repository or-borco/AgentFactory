"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AgentFormModal, type AgentFormValues } from "@/components/AgentFormModal";
import { Badge, Breadcrumb, Button, Card, CardLink } from "@/components/ui";
import { ChatIcon, PlusIcon, SettingsIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";
import { relativeTime } from "@/lib/relative-time";

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { getAgent, sessionsForAgent, updateAgent, createSession } = useMockBackend();
  const [showEdit, setShowEdit] = useState(false);
  const router = useRouter();

  const agent = getAgent(agentId);
  if (!agent) {
    return <div className="px-10 py-10 text-sm text-slate-500">Loading…</div>;
  }
  const sessions = sessionsForAgent(agent.id);

  return (
    <div className="pb-16">
      <div className="px-10 pt-8">
        <Breadcrumb href="/agents" label="Agents" />
      </div>

      <div className="flex items-start justify-between px-10 pt-4">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-2xl">
            {agent.avatarEmoji}
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">{agent.name}</h1>
            <p className="mt-0.5 text-sm text-slate-500">{agent.description}</p>
            {agent.mode === "automatic" && (
              <div className="mt-2">
                <Badge>Automatic</Badge>
              </div>
            )}
          </div>
        </div>
        <Button variant="secondary" onClick={() => setShowEdit(true)}>
          <SettingsIcon className="h-4 w-4" />
          Edit
        </Button>
      </div>

      <div className="px-10 pt-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">System prompt</p>
        <Card className="p-4 text-sm text-slate-700">{agent.systemPrompt}</Card>
      </div>

      <div className="px-10 pt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Sessions</h2>
          <Button
            onClick={() => {
              const session = createSession(agent.id);
              router.push(`/sessions/${session.id}`);
            }}
          >
            <PlusIcon className="h-4 w-4" />
            New session
          </Button>
        </div>

        {sessions.length === 0 ? (
          <Card className="px-5 py-10 text-center text-sm text-slate-500">No sessions yet.</Card>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => (
              <CardLink key={session.id} href={`/sessions/${session.id}`} className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <ChatIcon className="h-4 w-4 text-slate-400" />
                  <span className="text-sm font-medium text-slate-900">{session.title}</span>
                </div>
                <span className="text-xs text-slate-400">{relativeTime(session.lastActivityAt)}</span>
              </CardLink>
            ))}
          </div>
        )}
      </div>

      {showEdit && (
        <AgentFormModal
          title="Edit agent"
          submitLabel="Save changes"
          initial={{
            name: agent.name,
            description: agent.description ?? "",
            systemPrompt: agent.systemPrompt,
            mode: agent.mode,
          }}
          onClose={() => setShowEdit(false)}
          onSubmit={(values: AgentFormValues) => {
            updateAgent(agent.id, values);
            setShowEdit(false);
          }}
        />
      )}
    </div>
  );
}
