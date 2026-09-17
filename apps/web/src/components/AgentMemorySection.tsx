"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Textarea } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

// Mirrors the AgentMemoryEntry & { content: string } shape GET /api/agents/[agentId]/memory
// returns (packages/db/src/repositories/agent-memory.ts). Kept local rather than imported from
// @agentfactory/db since client components only pull domain shapes from @agentfactory/core, and
// `content` is deliberately not part of AgentMemoryEntry there.
interface MemoryEntry {
  id: number;
  agentId: number;
  orgId: number;
  source: "manual" | "retrospective";
  weight: number;
  content: string;
  createdAt: string;
  lastReinforcedAt: string;
}

export function AgentMemorySection({ agentId }: { agentId: number }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const rows = await apiFetch<MemoryEntry[]>(`/api/agents/${agentId}/memory`);
      setEntries(rows);
      setError(null);
    } catch {
      setError(t("agentMemory.loadError"));
    }
  }, [agentId, t]);

  useEffect(() => {
    // Initial fetch on mount; load() is async, so any setState it makes lands in a later
    // microtask, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function withBusy(id: number, fn: () => Promise<void>, failMessage: string) {
    setBusyIds((prev) => new Set(prev).add(id));
    return fn()
      .catch(() => setError(failMessage))
      .finally(() =>
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      );
  }

  function startEdit(entry: MemoryEntry) {
    setEditingId(entry.id);
    setDraft(entry.content);
  }

  function saveEdit(id: number) {
    return withBusy(
      id,
      async () => {
        await apiFetch(`/api/agents/${agentId}/memory/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ content: draft }),
        });
        setEntries((prev) => prev?.map((e) => (e.id === id ? { ...e, content: draft } : e)) ?? null);
        setEditingId(null);
      },
      t("agentMemory.saveFailed"),
    );
  }

  function confirmDelete(id: number) {
    return withBusy(
      id,
      async () => {
        await apiFetch(`/api/agents/${agentId}/memory/${id}`, { method: "DELETE" });
        setEntries((prev) => prev?.filter((e) => e.id !== id) ?? null);
        setConfirmDeleteId(null);
      },
      t("agentMemory.deleteFailed"),
    );
  }

  return (
    <div className="px-10 pt-8">
      <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t("agentMemory.title")}</h2>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {entries === null ? (
        error ? null : <p className="text-sm text-[var(--color-neutral-500)]">{t("common.loading")}</p>
      ) : entries.length === 0 ? (
        <Card className="px-5 py-10 text-center text-sm text-[var(--color-neutral-500)]">
          {t("agentMemory.emptyState")}
        </Card>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <MemoryEntryCard
              key={entry.id}
              entry={entry}
              isEditing={editingId === entry.id}
              isConfirmingDelete={confirmDeleteId === entry.id}
              isBusy={busyIds.has(entry.id)}
              draft={draft}
              onStartEdit={() => startEdit(entry)}
              onDraftChange={setDraft}
              onSaveEdit={() => saveEdit(entry.id)}
              onCancelEdit={() => setEditingId(null)}
              onStartDelete={() => setConfirmDeleteId(entry.id)}
              onConfirmDelete={() => confirmDelete(entry.id)}
              onCancelDelete={() => setConfirmDeleteId(null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface MemoryEntryCardProps {
  entry: MemoryEntry;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  isBusy: boolean;
  draft: string;
  onStartEdit: () => void;
  onDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

function MemoryEntryCard({
  entry,
  isEditing,
  isConfirmingDelete,
  isBusy,
  draft,
  onStartEdit,
  onDraftChange,
  onSaveEdit,
  onCancelEdit,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: MemoryEntryCardProps) {
  const { t } = useTranslation();

  return (
    <Card className="px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <Badge>{t(entry.source === "manual" ? "agentMemory.sourceManual" : "agentMemory.sourceRetrospective")}</Badge>
        {entry.weight > 1 && <Badge tone="success">{t("agentMemory.reinforcedLabel", { count: entry.weight })}</Badge>}
      </div>
      {isEditing ? (
        <MemoryEntryEditForm draft={draft} isBusy={isBusy} onDraftChange={onDraftChange} onSave={onSaveEdit} onCancel={onCancelEdit} />
      ) : isConfirmingDelete ? (
        <MemoryEntryDeleteConfirm isBusy={isBusy} onConfirm={onConfirmDelete} onCancel={onCancelDelete} />
      ) : (
        <MemoryEntryDisplay content={entry.content} onEdit={onStartEdit} onDelete={onStartDelete} />
      )}
    </Card>
  );
}

interface MemoryEntryEditFormProps {
  draft: string;
  isBusy: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

// The textarea is pre-filled by the caller: AgentMemorySection.startEdit sets `draft` from the
// entry's own `content` (already decrypted server-side by GET .../memory) before switching this
// entry into edit mode, so `draft` is never empty here unless the original lesson was.
function MemoryEntryEditForm({ draft, isBusy, onDraftChange, onSave, onCancel }: MemoryEntryEditFormProps) {
  const { t } = useTranslation();

  return (
    <div>
      <Textarea value={draft} onChange={(e) => onDraftChange(e.target.value)} rows={3} />
      <div className="mt-2 flex gap-2">
        <Button disabled={isBusy} onClick={onSave}>
          {t("agentMemory.saveButton")}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t("agentMemory.cancelButton")}
        </Button>
      </div>
    </div>
  );
}

interface MemoryEntryDeleteConfirmProps {
  isBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function MemoryEntryDeleteConfirm({ isBusy, onConfirm, onCancel }: MemoryEntryDeleteConfirmProps) {
  const { t } = useTranslation();

  return (
    <div>
      <p className="mb-2 text-sm text-[var(--color-text)]">{t("agentMemory.confirmDeleteTitle")}</p>
      <p className="mb-3 text-xs text-[var(--color-neutral-500)]">{t("agentMemory.confirmDeleteMessage")}</p>
      <div className="flex gap-2">
        <Button disabled={isBusy} onClick={onConfirm}>
          {t("agentMemory.confirmDeleteButton")}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t("agentMemory.cancelButton")}
        </Button>
      </div>
    </div>
  );
}

interface MemoryEntryDisplayProps {
  content: string;
  onEdit: () => void;
  onDelete: () => void;
}

function MemoryEntryDisplay({ content, onEdit, onDelete }: MemoryEntryDisplayProps) {
  const { t } = useTranslation();

  return (
    <div>
      <p className="text-sm text-[var(--color-text)]">{content}</p>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" onClick={onEdit}>
          {t("agentMemory.editButton")}
        </Button>
        <Button variant="secondary" onClick={onDelete}>
          {t("agentMemory.deleteButton")}
        </Button>
      </div>
    </div>
  );
}
