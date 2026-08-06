"use client";

import { useState, useCallback } from "react";
import {
  BookOpen,
  Buildings,
  Stack,
  HardDrives,
  PencilSimple,
} from "@phosphor-icons/react";
import { Button, Badge, Textarea } from "@agentfactory/shared";
import { ChevronDownIcon, XIcon } from "@/lib/icons";
import { useTranslation } from "@/lib/i18n/context";
import type {
  SharedContextData,
  ContextCategory,
  TermEntry,
  ArchEntry,
  SystemEntry,
} from "@/lib/shared-context";
import { countEntries } from "@/lib/shared-context";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PanelState {
  open: boolean;
  dirty: boolean;
  saving: boolean;
  draft: ContextCategory;
  original: ContextCategory;
  labelEditing: boolean;
  labelDraft: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDirty(draft: ContextCategory, original: ContextCategory): boolean {
  return JSON.stringify(draft) !== JSON.stringify(original);
}

function generateId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `cat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function categoryIcon(type: ContextCategory["type"]) {
  switch (type) {
    case "terms":
      return <BookOpen size={16} />;
    case "text":
      return <Buildings size={16} />;
    case "entries":
      return <Stack size={16} />;
    case "systems":
      return <HardDrives size={16} />;
  }
}

function initPanels(data: SharedContextData): Map<string, PanelState> {
  const map = new Map<string, PanelState>();
  for (const cat of data.categories) {
    map.set(cat.id, {
      open: cat.id === "domain-terminology",
      dirty: false,
      saving: false,
      draft: structuredClone(cat),
      original: cat,
      labelEditing: false,
      labelDraft: cat.label,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SharedContextPanelsProps {
  data: SharedContextData;
  usedBytes: number;
  maxBytes: number;
  onSave: (updated: SharedContextData) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Sub-components for panel bodies
// ---------------------------------------------------------------------------

function TermsBody({
  entries,
  onChange,
  t,
}: {
  entries: TermEntry[];
  onChange: (entries: TermEntry[]) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const update = (i: number, field: keyof TermEntry, value: string) => {
    const next = entries.map((e, idx) =>
      idx === i ? { ...e, [field]: value } : e,
    );
    onChange(next);
  };
  const remove = (i: number) => onChange(entries.filter((_, idx) => idx !== i));
  const add = () => onChange([...entries, { key: "", value: "" }]);

  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((entry, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            value={entry.key}
            onChange={(e) => update(i, "key", e.target.value)}
            placeholder={t("teamsV2.termKeyPlaceholder")}
            className="w-32 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-xs text-[var(--color-text)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <input
            value={entry.value}
            onChange={(e) => update(i, "value", e.target.value)}
            placeholder={t("teamsV2.termValuePlaceholder")}
            className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none"
          />
          <button
            onClick={() => remove(i)}
            className="shrink-0 text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-200)] transition-colors"
            aria-label="Remove"
          >
            <XIcon size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="mt-1 self-start text-xs text-[var(--color-accent)] hover:opacity-80 transition-opacity"
      >
        {t("teamsV2.addTerm")}
      </button>
    </div>
  );
}

function TextBody({
  text,
  onChange,
  t,
}: {
  text: string;
  onChange: (text: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <Textarea
      value={text}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t("teamsV2.textPlaceholder")}
      rows={5}
      className="text-xs"
    />
  );
}

function EntriesBody({
  entries,
  onChange,
  t,
}: {
  entries: ArchEntry[];
  onChange: (entries: ArchEntry[]) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const update = (i: number, field: keyof ArchEntry, value: string) => {
    const next = entries.map((e, idx) =>
      idx === i ? { ...e, [field]: value } : e,
    );
    onChange(next);
  };
  const remove = (i: number) => onChange(entries.filter((_, idx) => idx !== i));
  const add = () => onChange([...entries, { title: "", desc: "" }]);

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, i) => (
        <div
          key={i}
          className="flex gap-2 items-start rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface-alt,var(--color-surface))] p-2"
        >
          <div className="min-w-0 flex-1 flex flex-col gap-1.5">
            <input
              value={entry.title}
              onChange={(e) => update(i, "title", e.target.value)}
              placeholder={t("teamsV2.entryTitlePlaceholder")}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-2 py-1.5 text-xs font-semibold text-[var(--color-text)] placeholder:text-[var(--color-neutral-600)] placeholder:font-normal focus:border-[var(--color-accent)] focus:outline-none"
            />
            <input
              value={entry.desc}
              onChange={(e) => update(i, "desc", e.target.value)}
              placeholder={t("teamsV2.entryDescPlaceholder")}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-neutral-400)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <button
            onClick={() => remove(i)}
            className="mt-1 shrink-0 text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-200)] transition-colors"
            aria-label="Remove"
          >
            <XIcon size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="mt-1 self-start text-xs text-[var(--color-accent)] hover:opacity-80 transition-opacity"
      >
        {t("teamsV2.addDecision")}
      </button>
    </div>
  );
}

function SystemsBody({
  entries,
  onChange,
  t,
}: {
  entries: SystemEntry[];
  onChange: (entries: SystemEntry[]) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const update = (i: number, field: keyof SystemEntry, value: string) => {
    const next = entries.map((e, idx) =>
      idx === i ? { ...e, [field]: value } : e,
    );
    onChange(next);
  };
  const remove = (i: number) => onChange(entries.filter((_, idx) => idx !== i));
  const add = () => onChange([...entries, { name: "", type: "", notes: "" }]);

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, i) => (
        <div
          key={i}
          className="flex gap-2 items-start rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface-alt,var(--color-surface))] p-2"
        >
          <div className="min-w-0 flex-1 grid grid-cols-2 gap-1.5">
            <input
              value={entry.name}
              onChange={(e) => update(i, "name", e.target.value)}
              placeholder={t("teamsV2.systemNamePlaceholder")}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-text)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none"
            />
            <input
              value={entry.type}
              onChange={(e) => update(i, "type", e.target.value)}
              placeholder={t("teamsV2.systemTypePlaceholder")}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-neutral-400)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none"
            />
            <input
              value={entry.notes}
              onChange={(e) => update(i, "notes", e.target.value)}
              placeholder={t("teamsV2.systemNotesPlaceholder")}
              className="col-span-2 w-full rounded-[var(--radius-sm)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-neutral-400)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <button
            onClick={() => remove(i)}
            className="mt-1 shrink-0 text-[var(--color-neutral-500)] hover:text-[var(--color-neutral-200)] transition-colors"
            aria-label="Remove"
          >
            <XIcon size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="mt-1 self-start text-xs text-[var(--color-accent)] hover:opacity-80 transition-opacity"
      >
        {t("teamsV2.addSystem")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SharedContextPanels({
  data,
  usedBytes,
  maxBytes,
  onSave,
}: SharedContextPanelsProps) {
  const { t } = useTranslation();

  // panels is a Map keyed by category id; order is preserved via categoryOrder
  const [panels, setPanels] = useState<Map<string, PanelState>>(() =>
    initPanels(data),
  );
  const [categoryOrder, setCategoryOrder] = useState<string[]>(() =>
    data.categories.map((c) => c.id),
  );

  // Usage bar
  const ratio = Math.min(usedBytes / maxBytes, 1);
  const overLimit = usedBytes > maxBytes;
  const usedKB = (usedBytes / 1024).toFixed(1);
  const maxKB = Math.round(maxBytes / 1024);

  // Helpers to update panel state immutably
  const updatePanel = useCallback(
    (id: string, update: Partial<PanelState> | ((prev: PanelState) => Partial<PanelState>)) => {
      setPanels((prev) => {
        const existing = prev.get(id);
        if (!existing) return prev;
        const patch =
          typeof update === "function" ? update(existing) : update;
        const next = new Map(prev);
        next.set(id, { ...existing, ...patch });
        return next;
      });
    },
    [],
  );

  const toggleOpen = useCallback(
    (id: string) => {
      updatePanel(id, (p) => ({ open: !p.open }));
    },
    [updatePanel],
  );

  const updateDraftCategory = useCallback(
    (id: string, category: ContextCategory) => {
      updatePanel(id, (p) => ({
        draft: category,
        dirty: isDirty(category, p.original),
      }));
    },
    [updatePanel],
  );

  // Save handler for a single panel
  const handleSave = useCallback(
    async (id: string) => {
      const panel = panels.get(id);
      if (!panel) return;
      updatePanel(id, { saving: true });

      // Build updated SharedContextData
      const updatedCategories = categoryOrder.map((cid) => {
        const p = panels.get(cid);
        if (!p) return panel.draft; // fallback (shouldn't happen)
        return cid === id ? panel.draft : p.draft;
      });

      try {
        await onSave({ categories: updatedCategories });
        // Mark as clean
        updatePanel(id, (p) => ({
          saving: false,
          dirty: false,
          original: p.draft,
        }));
      } catch {
        updatePanel(id, { saving: false });
      }
    },
    [panels, categoryOrder, onSave, updatePanel],
  );

  // Add category
  const handleAddCategory = useCallback(() => {
    const id = generateId();
    const newCat: ContextCategory = {
      id,
      label: t("teamsV2.newCategory"),
      type: "text",
      entries: [],
    };
    const newPanel: PanelState = {
      open: true,
      dirty: true,
      saving: false,
      draft: newCat,
      original: newCat,
      labelEditing: false,
      labelDraft: newCat.label,
    };
    setPanels((prev) => {
      const next = new Map(prev);
      next.set(id, newPanel);
      return next;
    });
    setCategoryOrder((prev) => [...prev, id]);
  }, [t]);

  // Label editing
  const startLabelEdit = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const panel = panels.get(id);
      if (!panel) return;
      updatePanel(id, { labelEditing: true, labelDraft: panel.draft.label });
    },
    [panels, updatePanel],
  );

  const commitLabelEdit = useCallback(
    (id: string) => {
      const panel = panels.get(id);
      if (!panel) return;
      const newLabel = panel.labelDraft.trim() || panel.draft.label;
      const updatedDraft = { ...panel.draft, label: newLabel };
      updatePanel(id, {
        labelEditing: false,
        draft: updatedDraft,
        dirty: isDirty(updatedDraft, panel.original),
      });
    },
    [panels, updatePanel],
  );

  // Body change handlers per category type
  const handleTermsChange = useCallback(
    (id: string, entries: TermEntry[]) => {
      const panel = panels.get(id);
      if (!panel || panel.draft.type !== "terms") return;
      updateDraftCategory(id, { ...panel.draft, entries });
    },
    [panels, updateDraftCategory],
  );

  const handleTextChange = useCallback(
    (id: string, text: string) => {
      const panel = panels.get(id);
      if (!panel || panel.draft.type !== "text") return;
      const entries = text.length > 0 ? ([{ text }] as [{ text: string }]) : ([] as []);
      updateDraftCategory(id, { ...panel.draft, entries });
    },
    [panels, updateDraftCategory],
  );

  const handleEntriesChange = useCallback(
    (id: string, entries: ArchEntry[]) => {
      const panel = panels.get(id);
      if (!panel || panel.draft.type !== "entries") return;
      updateDraftCategory(id, { ...panel.draft, entries });
    },
    [panels, updateDraftCategory],
  );

  const handleSystemsChange = useCallback(
    (id: string, entries: SystemEntry[]) => {
      const panel = panels.get(id);
      if (!panel || panel.draft.type !== "systems") return;
      updateDraftCategory(id, { ...panel.draft, entries });
    },
    [panels, updateDraftCategory],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* KB usage indicator */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-[var(--color-neutral-400)]">
          {t("teamsV2.sharedContextUsage", { used: usedKB, max: maxKB })}
        </span>
        <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-divider)]">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${ratio * 100}%`,
              backgroundColor: overLimit ? "#e06060" : "var(--color-accent)",
            }}
          />
        </div>
      </div>

      {/* Accordion panels */}
      {categoryOrder.map((id) => {
        const panel = panels.get(id);
        if (!panel) return null;
        const { draft, open, dirty, saving, labelEditing, labelDraft } = panel;

        return (
          <div
            key={id}
            className="rounded-[var(--radius-md)] border border-[var(--color-divider)] overflow-hidden"
          >
            {/* Panel header */}
            <div
              className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-[var(--color-neutral-900)] transition-colors select-none"
              onClick={() => toggleOpen(id)}
            >
              {/* Icon */}
              <span className="shrink-0 text-[var(--color-neutral-400)]">
                {categoryIcon(draft.type)}
              </span>

              {/* Label (or editing input) */}
              {labelEditing ? (
                <input
                  autoFocus
                  value={labelDraft}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    updatePanel(id, { labelDraft: e.target.value })
                  }
                  onBlur={() => commitLabelEdit(id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitLabelEdit(id);
                    if (e.key === "Escape") {
                      updatePanel(id, { labelEditing: false });
                    }
                  }}
                  className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-accent)] bg-[var(--color-surface)] px-2 py-0.5 text-sm font-medium text-[var(--color-text)] focus:outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text)]">
                  {draft.label}
                </span>
              )}

              {/* Entry count badge */}
              <Badge>{countEntries(draft)}</Badge>

              {/* Edit label icon (only when not in label-editing mode) */}
              {!labelEditing && (
                <button
                  onClick={(e) => startLabelEdit(id, e)}
                  className="shrink-0 text-[var(--color-neutral-600)] hover:text-[var(--color-neutral-300)] transition-colors"
                  aria-label="Edit label"
                >
                  <PencilSimple size={13} />
                </button>
              )}

              {/* Save button (only when dirty) */}
              {dirty && !labelEditing && (
                <Button
                  variant="primary"
                  disabled={saving}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleSave(id);
                  }}
                  className="px-2 py-0.5 text-xs"
                >
                  {saving ? "Saving…" : t("common.save")}
                </Button>
              )}

              {/* Chevron */}
              <span
                className={`shrink-0 text-[var(--color-neutral-500)] transition-transform duration-200 ${
                  open ? "rotate-180" : ""
                }`}
              >
                <ChevronDownIcon size={14} />
              </span>
            </div>

            {/* Panel body */}
            {open && (
              <div className="border-t border-[var(--color-divider)] px-3 py-3">
                {draft.type === "terms" && (
                  <TermsBody
                    entries={draft.entries}
                    onChange={(entries) => handleTermsChange(id, entries)}
                    t={t}
                  />
                )}
                {draft.type === "text" && (
                  <TextBody
                    text={draft.entries[0]?.text ?? ""}
                    onChange={(text) => handleTextChange(id, text)}
                    t={t}
                  />
                )}
                {draft.type === "entries" && (
                  <EntriesBody
                    entries={draft.entries}
                    onChange={(entries) => handleEntriesChange(id, entries)}
                    t={t}
                  />
                )}
                {draft.type === "systems" && (
                  <SystemsBody
                    entries={draft.entries}
                    onChange={(entries) => handleSystemsChange(id, entries)}
                    t={t}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Add category link */}
      <button
        onClick={handleAddCategory}
        className="self-start text-xs text-[var(--color-accent)] hover:opacity-80 transition-opacity"
      >
        {t("teamsV2.addCategory")}
      </button>
    </div>
  );
}
