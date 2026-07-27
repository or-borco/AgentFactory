"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Button, Textarea, TextInput } from "@/components/ui";
import type { AgentMode } from "@agentfactory/core";

export interface AgentFormValues {
  name: string;
  description: string;
  systemPrompt: string;
  mode: AgentMode;
}

export function AgentFormModal({
  title,
  submitLabel,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: Partial<AgentFormValues>;
  onClose: () => void;
  onSubmit: (values: AgentFormValues) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [mode, setMode] = useState<AgentMode>(initial?.mode ?? "manual");

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !systemPrompt.trim()) return;
          onSubmit({ name: name.trim(), description: description.trim(), systemPrompt: systemPrompt.trim(), mode });
        }}
      >
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Name</label>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Code reviewer" required />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Description</label>
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line describing what this agent does" />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">System prompt</label>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={4}
            placeholder="Describe the agent's purpose and how it should behave"
            required
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Mode</label>
          <div className="flex gap-2">
            {(["manual", "automatic"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium capitalize transition-colors ${
                  mode === m ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {mode === "manual" ? "Responds only when messaged directly." : "Also runs automatically from configured triggers."}
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">{submitLabel}</Button>
        </div>
      </form>
    </Modal>
  );
}
