"use client";

import { useState } from "react";
import { Badge, Button, EmptyState, PageHeader, Tabs, TextInput, Textarea, Truncate, UsageMeter } from "@agentfactory/shared";
import { useMockBackend } from "@/lib/mock/context";
import { useTranslation } from "@/lib/i18n/context";
import type { Agent, Team, TeamContextItem } from "@agentfactory/core";

const SHARED_CONTEXT_MAX = 65536; // 64 KB

// ── Members tab ────────────────────────────────────────────────────────────────

function MembersTab({ team }: { team: Team }) {
  const { t } = useTranslation();
  const { orgMembers, contextItemsForTeam, createContextItem, deleteContextItem, notify } = useMockBackend();
  const [addingDoc, setAddingDoc] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const items = contextItemsForTeam(team.id);
  const usedBytes = new TextEncoder().encode(team.sharedContext).length;

  async function handleAddDoc(e: React.FormEvent) {
    e.preventDefault();
    if (!docTitle.trim()) return;
    setSaving(true);
    try {
      await createContextItem(team.id, docTitle.trim());
      notify("toast.contextItemAdded");
      setDocTitle("");
      setAddingDoc(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteItem(item: TeamContextItem) {
    await deleteContextItem(team.id, item.id);
    notify("toast.contextItemDeleted");
  }

  return (
    <div className="space-y-8 py-6">
      {/* Members list */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-neutral-300)]">
          {t("teamsV2.membersSection")}
        </h3>
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-divider)]">
          <table className="w-full text-sm">
            <tbody>
              {orgMembers.map((m, i) => (
                <tr
                  key={m.userId}
                  className={i < orgMembers.length - 1 ? "border-b border-[var(--color-divider)]" : ""}
                >
                  <td className="px-4 py-3 text-[var(--color-neutral-200)]">{m.name}</td>
                  <td className="px-4 py-3 text-[var(--color-neutral-500)]">{m.email}</td>
                  <td className="px-4 py-3 text-right">
                    <Badge tone={m.role === "owner" ? "success" : "neutral"}>
                      {t(`teamsV2.role.${m.role}`)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Shared context + usage meter */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-[var(--color-neutral-300)]">
          {t("teamsV2.sharedContextSection")}
        </h3>
        <UsageMeter
          usedBytes={usedBytes}
          maxBytes={SHARED_CONTEXT_MAX}
          label={t("teamsV2.usageMeterLabel")}
        />
        <p className="mt-2 text-xs text-[var(--color-neutral-500)] line-clamp-3">
          {team.sharedContext || <span className="italic">Empty</span>}
        </p>
      </section>

      {/* Context documents */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-neutral-300)]">
              {t("teamsV2.contextDocsSection")}
            </h3>
            <p className="text-xs text-[var(--color-neutral-500)]">{t("teamsV2.contextDocsDescription")}</p>
          </div>
          {!addingDoc && (
            <Button variant="secondary" onClick={() => setAddingDoc(true)}>
              {t("teamsV2.addDocument")}
            </Button>
          )}
        </div>

        {addingDoc && (
          <form onSubmit={handleAddDoc} className="mb-4 flex gap-2">
            <TextInput
              autoFocus
              placeholder={t("teamsV2.addDocumentPlaceholder")}
              value={docTitle}
              onChange={(e) => setDocTitle(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" disabled={saving || !docTitle.trim()}>
              {t("common.save")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setAddingDoc(false); setDocTitle(""); }}
            >
              {t("common.cancel")}
            </Button>
          </form>
        )}

        {items.length === 0 && !addingDoc ? (
          <EmptyState
            icon="📄"
            title={t("teamsV2.noContextDocs")}
            subtitle={t("teamsV2.noContextDocsSub")}
          />
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-divider)] px-4 py-2.5"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm text-[var(--color-neutral-200)]">{item.title}</span>
                  {item.sizeBytes > 0 && (
                    <span className="text-xs text-[var(--color-neutral-500)]">
                      {(item.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleDeleteItem(item)}
                  className="text-xs text-[var(--color-neutral-500)] hover:text-red-400 transition-colors cursor-pointer"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Area map editor ────────────────────────────────────────────────────────────

function AreaMapEditor({
  areaMap,
  onChange,
}: {
  areaMap: Record<string, string>;
  onChange: (map: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(areaMap);

  function updateEntry(oldPath: string, field: "path" | "desc", value: string) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(areaMap)) {
      if (k === oldPath) {
        if (field === "path") next[value] = v;
        else next[k] = value;
      } else {
        next[k] = v;
      }
    }
    onChange(next);
  }

  function removeEntry(path: string) {
    const next = { ...areaMap };
    delete next[path];
    onChange(next);
  }

  function addEntry() {
    onChange({ ...areaMap, "": "" });
  }

  return (
    <div className="space-y-2">
      {entries.map(([path, desc]) => (
        <div key={path} className="flex gap-2">
          <TextInput
            placeholder={t("teamsV2.areaMapPathPlaceholder")}
            value={path}
            onChange={(e) => updateEntry(path, "path", e.target.value)}
            className="w-48 shrink-0 font-mono text-xs"
          />
          <TextInput
            placeholder={t("teamsV2.areaMapDescPlaceholder")}
            value={desc}
            onChange={(e) => updateEntry(path, "desc", e.target.value)}
            className="flex-1"
          />
          <button
            onClick={() => removeEntry(path)}
            className="px-2 text-[var(--color-neutral-500)] hover:text-red-400 transition-colors cursor-pointer"
          >
            ×
          </button>
        </div>
      ))}
      <Button variant="secondary" onClick={addEntry} className="text-xs">
        + {t("teamsV2.addArea")}
      </Button>
    </div>
  );
}

// ── Agent card ─────────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { updateAgent, deleteAgent, notify } = useMockBackend();

  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [defaultCodebase, setDefaultCodebase] = useState(agent.defaultCodebase ?? "");
  const [areaMap, setAreaMap] = useState<Record<string, string>>(agent.areaMap ?? {});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await updateAgent(agent.id, { systemPrompt, defaultCodebase, areaMap });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteAgent(agent.id);
    } finally {
      setDeleting(false);
    }
  }

  const dirty =
    systemPrompt !== agent.systemPrompt ||
    defaultCodebase !== (agent.defaultCodebase ?? "") ||
    JSON.stringify(areaMap) !== JSON.stringify(agent.areaMap ?? {});

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-divider)] p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{agent.avatarEmoji ?? "🤖"}</span>
          <div>
            <div className="font-medium text-[var(--color-neutral-100)]">{agent.name}</div>
            {agent.description && (
              <Truncate text={agent.description} className="text-xs text-[var(--color-neutral-500)]" />
            )}
          </div>
        </div>
        <Badge tone={agent.mode === "automatic" ? "success" : "neutral"}>
          {agent.mode === "automatic" ? t("common.automatic") : "Manual"}
        </Badge>
      </div>

      {/* Default codebase */}
      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
          {t("teamsV2.defaultCodebaseLabel")}
        </label>
        <TextInput
          placeholder={t("teamsV2.defaultCodebasePlaceholder")}
          value={defaultCodebase}
          onChange={(e) => setDefaultCodebase(e.target.value)}
        />
      </div>

      {/* System prompt */}
      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
          {t("teamsV2.systemPromptLabel")}
        </label>
        <Textarea
          rows={3}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
      </div>

      {/* Area map */}
      <div>
        <div className="mb-2">
          <div className="text-xs font-medium text-[var(--color-neutral-400)]">{t("teamsV2.areaMapSection")}</div>
          <div className="text-xs text-[var(--color-neutral-500)]">{t("teamsV2.areaMapDescription")}</div>
        </div>
        <AreaMapEditor areaMap={areaMap} onChange={setAreaMap} />
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between pt-1">
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-[var(--color-neutral-400)]">
              {t("teamsV2.confirmDeleteSub")}
            </span>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="text-sm text-red-400 hover:text-red-300 disabled:opacity-50 cursor-pointer"
            >
              {t("teamsV2.confirmDeleteButton")}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-xs text-[var(--color-neutral-500)] hover:text-red-400 transition-colors cursor-pointer"
          >
            {t("teamsV2.deleteAgent")}
          </button>
        )}
        {dirty && (
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("common.save") + "…" : t("common.save")}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Agents tab ─────────────────────────────────────────────────────────────────

function AgentsTab({ team }: { team: Team }) {
  const { t } = useTranslation();
  const { agentsForTeam } = useMockBackend();
  const agents = agentsForTeam(team.id);

  return (
    <div className="space-y-4 py-6">
      {agents.length === 0 ? (
        <EmptyState icon="🤖" title={t("teamsV2.noAgents")} subtitle="" />
      ) : (
        agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function TeamsV2Page() {
  const { t } = useTranslation();
  const { teams } = useMockBackend();
  const [activeTab, setActiveTab] = useState<string>("members");
  const [activeTeamId, setActiveTeamId] = useState<number | null>(null);

  const team = activeTeamId != null
    ? teams.find((t) => t.id === activeTeamId)
    : teams[0];

  const tabs = [
    { key: "members", label: t("teamsV2.tabMembers") },
    { key: "agents", label: t("teamsV2.tabAgents") },
  ];

  return (
    <div className="px-10 pt-10 max-w-4xl">
      <PageHeader title={t("teamsV2.title")} subtitle={t("teamsV2.subtitle")} />

      {/* Team selector (if multiple teams) */}
      {teams.length > 1 && (
        <div className="mt-4 flex gap-2">
          {teams.map((tm) => (
            <button
              key={tm.id}
              onClick={() => setActiveTeamId(tm.id)}
              className={[
                "rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors cursor-pointer",
                tm.id === team?.id
                  ? "bg-[var(--color-accent-800)] text-[var(--color-accent-200)]"
                  : "text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-200)]",
              ].join(" ")}
            >
              {tm.name}
            </button>
          ))}
        </div>
      )}

      {team ? (
        <>
          <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} className="mt-6" />
          {activeTab === "members" && <MembersTab team={team} />}
          {activeTab === "agents" && <AgentsTab team={team} />}
        </>
      ) : (
        <EmptyState icon="🏢" title="No teams yet" subtitle="Create a team to get started." />
      )}
    </div>
  );
}
