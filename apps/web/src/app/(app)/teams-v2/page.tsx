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
    try {
      await deleteContextItem(team.id, item.id);
      notify("toast.contextItemDeleted");
    } catch {
      notify("toast.error");
    }
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

type AreaMapRow = { id: number; path: string; desc: string };

let nextRowId = 0;

function mapToRows(areaMap: Record<string, string>): AreaMapRow[] {
  return Object.entries(areaMap).map(([path, desc]) => ({ id: nextRowId++, path, desc }));
}

function rowsToMap(rows: AreaMapRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) out[row.path] = row.desc;
  return out;
}

function AreaMapEditor({
  areaMap,
  onChange,
}: {
  areaMap: Record<string, string>;
  onChange: (map: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AreaMapRow[]>(() => mapToRows(areaMap));

  function updateRow(id: number, field: "path" | "desc", value: string) {
    const next = rows.map((r) => (r.id === id ? { ...r, [field]: value } : r));
    setRows(next);
    onChange(rowsToMap(next));
  }

  function removeRow(id: number) {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    onChange(rowsToMap(next));
  }

  function addRow() {
    setRows((prev) => [...prev, { id: nextRowId++, path: "", desc: "" }]);
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.id} className="flex gap-2">
          <TextInput
            placeholder={t("teamsV2.areaMapPathPlaceholder")}
            value={row.path}
            onChange={(e) => updateRow(row.id, "path", e.target.value)}
            className="w-48 shrink-0 font-mono text-xs"
          />
          <TextInput
            placeholder={t("teamsV2.areaMapDescPlaceholder")}
            value={row.desc}
            onChange={(e) => updateRow(row.id, "desc", e.target.value)}
            className="flex-1"
          />
          <button
            onClick={() => removeRow(row.id)}
            className="px-2 text-[var(--color-neutral-500)] hover:text-red-400 transition-colors cursor-pointer"
          >
            ×
          </button>
        </div>
      ))}
      <Button variant="secondary" onClick={addRow} className="text-xs">
        + {t("teamsV2.addArea")}
      </Button>
    </div>
  );
}

// ── New agent panel ────────────────────────────────────────────────────────────

function NewAgentPanel({ teamId, onCreated, onCancel }: {
  teamId: number;
  onCreated: (agentId: number) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { createAgent } = useMockBackend();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [mode, setMode] = useState<"manual" | "automatic">("manual");
  const [saving, setSaving] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const agent = await createAgent({ name: name.trim(), description: description.trim(), systemPrompt: systemPrompt.trim(), mode, teamId });
      onCreated(agent.id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleCreate} className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--color-divider)]">
        <span className="text-2xl leading-none">🤖</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[var(--color-neutral-100)]">{t("teamsV2.newAgentTitle")}</div>
          <div className="text-xs text-[var(--color-neutral-500)]">{t("teamsV2.newAgentSubtitle")}</div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.agentNameLabel")}
          </label>
          <TextInput
            autoFocus
            placeholder={t("teamsV2.agentNamePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.agentDescriptionLabel")}
          </label>
          <TextInput
            placeholder={t("teamsV2.agentDescriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.systemPromptLabel")}
          </label>
          <Textarea
            rows={4}
            placeholder={t("teamsV2.systemPromptPlaceholder")}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-2 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.agentModeLabel")}
          </label>
          <div className="flex gap-2">
            {(["manual", "automatic"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={[
                  "flex-1 rounded-[var(--radius-sm)] border px-3 py-2 text-sm transition-colors cursor-pointer",
                  mode === m
                    ? "border-[var(--color-accent-500)] bg-[var(--color-accent-900)] text-[var(--color-accent-200)]"
                    : "border-[var(--color-divider)] text-[var(--color-neutral-400)] hover:text-[var(--color-neutral-200)]",
                ].join(" ")}
              >
                {m === "automatic" ? t("common.automatic") : "Manual"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--color-divider)]">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!name.trim() || saving}>
          {saving ? t("teamsV2.creatingAgent") : t("teamsV2.createAgent")}
        </Button>
      </div>
    </form>
  );
}

// ── Agent detail panel ─────────────────────────────────────────────────────────

function AgentDetailPanel({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { updateAgent, deleteAgent, notify } = useMockBackend();

  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  const [defaultCodebase, setDefaultCodebase] = useState(agent.defaultCodebase ?? "");
  const [areaMap, setAreaMap] = useState<Record<string, string>>(agent.areaMap ?? {});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function sortedJson(map: Record<string, string>) {
    return JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
  }

  const dirty =
    systemPrompt !== agent.systemPrompt ||
    defaultCodebase !== (agent.defaultCodebase ?? "") ||
    sortedJson(areaMap) !== sortedJson(agent.areaMap ?? {});

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
    } catch {
      notify("toast.error");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Detail header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--color-divider)]">
        <span className="text-2xl leading-none">{agent.avatarEmoji ?? "🤖"}</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[var(--color-neutral-100)] truncate">{agent.name}</div>
          {agent.description && (
            <div className="text-xs text-[var(--color-neutral-500)] truncate">{agent.description}</div>
          )}
        </div>
        <Badge tone={agent.mode === "automatic" ? "success" : "neutral"}>
          {agent.mode === "automatic" ? t("common.automatic") : "Manual"}
        </Badge>
      </div>

      {/* Scrollable fields */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
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

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.systemPromptLabel")}
          </label>
          <Textarea
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </div>

        <div>
          <div className="mb-2">
            <div className="text-xs font-medium text-[var(--color-neutral-400)]">{t("teamsV2.areaMapSection")}</div>
            <div className="text-xs text-[var(--color-neutral-500)]">{t("teamsV2.areaMapDescription")}</div>
          </div>
          <AreaMapEditor areaMap={areaMap} onChange={setAreaMap} />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--color-divider)]">
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-[var(--color-neutral-400)]">{t("teamsV2.confirmDeleteSub")}</span>
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
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? t("common.save") + "…" : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

// ── Agents tab ─────────────────────────────────────────────────────────────────

function AgentsTab({ team }: { team: Team }) {
  const { t } = useTranslation();
  const { agentsForTeam } = useMockBackend();
  const agents = agentsForTeam(team.id);
  const [selectedId, setSelectedId] = useState<number | null>(agents[0]?.id ?? null);
  const [creating, setCreating] = useState(false);

  // If the selected agent was deleted or agents changed, fall back to first
  const selected = agents.find((a) => a.id === selectedId) ?? agents[0] ?? null;

  return (
    <div className="mt-6 flex rounded-[var(--radius-md)] border border-[var(--color-divider)] overflow-hidden" style={{ minHeight: "460px" }}>
      {/* Agent list */}
      <div className="w-56 shrink-0 border-r border-[var(--color-divider)] flex flex-col">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--color-divider)]">
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-neutral-500)]">
            {t("teamsV2.tabAgents")}
          </span>
          <button
            onClick={() => { setCreating(true); setSelectedId(null); }}
            className="text-lg leading-none text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-100)] transition-colors cursor-pointer"
            title={t("teamsV2.newAgentTitle")}
            aria-label={t("teamsV2.newAgentTitle")}
          >
            +
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {agents.map((agent) => {
            const isActive = !creating && agent.id === (selected?.id ?? -1);
            return (
              <button
                key={agent.id}
                onClick={() => { setSelectedId(agent.id); setCreating(false); }}
                className={[
                  "w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-[var(--color-divider)] last:border-0 transition-colors cursor-pointer",
                  isActive
                    ? "bg-[var(--color-accent-900)]"
                    : "hover:bg-[var(--color-neutral-900)]",
                ].join(" ")}
              >
                <span className="text-lg leading-none shrink-0">{agent.avatarEmoji ?? "🤖"}</span>
                <div className="flex-1 min-w-0">
                  <div className={[
                    "text-sm font-medium truncate",
                    isActive ? "text-[var(--color-accent-200)]" : "text-[var(--color-neutral-200)]",
                  ].join(" ")}>
                    {agent.name}
                  </div>
                  {agent.description && (
                    <div className="text-xs text-[var(--color-neutral-500)] truncate">{agent.description}</div>
                  )}
                </div>
                <div
                  className={[
                    "w-1.5 h-1.5 rounded-full shrink-0",
                    agent.mode === "automatic" ? "bg-green-400" : "bg-[var(--color-neutral-600)]",
                  ].join(" ")}
                  title={agent.mode === "automatic" ? t("common.automatic") : "Manual"}
                />
              </button>
            );
          })}
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 min-w-0">
        {creating ? (
          <NewAgentPanel
            teamId={team.id}
            onCreated={(id) => { setSelectedId(id); setCreating(false); }}
            onCancel={() => { setCreating(false); }}
          />
        ) : selected ? (
          <AgentDetailPanel key={selected.id} agent={selected} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon="🤖" title={t("teamsV2.noAgents")} subtitle={t("teamsV2.noAgentsSub")} />
          </div>
        )}
      </div>
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
