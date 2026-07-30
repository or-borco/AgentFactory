"use client";

import { XIcon } from "@/lib/icons";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "color-mix(in srgb, var(--color-neutral-900) 50%, transparent)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[var(--color-surface)] p-6"
        style={{ borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-[var(--radius-sm)] p-1 text-[var(--color-neutral-500)] hover:bg-[var(--color-neutral-900)] hover:text-[var(--color-neutral-200)]"
          >
            <XIcon size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
