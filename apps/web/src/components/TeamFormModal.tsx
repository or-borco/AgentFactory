"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Button, TextInput } from "@/components/ui";

export function TeamFormModal({
  title,
  submitLabel,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: { name: string; description: string };
  onClose: () => void;
  onSubmit: (values: { name: string; description: string }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit({ name: name.trim(), description: description.trim() });
        }}
      >
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Name</label>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Platform team" required />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">Description</label>
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
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
