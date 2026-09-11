import type { ReactNode } from "react";
import { Card } from "./Card";

export interface MultiSelectItem {
  id: number;
  label: string;
  sublabel?: string;
  trailing?: ReactNode;
}

export interface MultiSelectCheckboxListProps {
  items: MultiSelectItem[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  disabledIds?: Set<number>;
  emptyMessage?: string;
}

export function MultiSelectCheckboxList({
  items,
  selectedIds,
  onToggle,
  disabledIds,
  emptyMessage,
}: MultiSelectCheckboxListProps) {
  if (items.length === 0) {
    return (
      <Card className="px-5 py-6 text-center text-sm text-[var(--color-neutral-500)]">{emptyMessage}</Card>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-divider)]">
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`flex items-center gap-3 px-4 py-3 ${
            i < items.length - 1 ? "border-b border-[var(--color-divider)]" : ""
          }`}
        >
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={selectedIds.has(item.id)}
              disabled={disabledIds?.has(item.id)}
              onChange={() => !disabledIds?.has(item.id) && onToggle(item.id)}
              className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-accent-600)] disabled:cursor-not-allowed"
            />
            <span className="truncate text-sm text-[var(--color-text)]">{item.label}</span>
            {item.sublabel && (
              <span className="shrink-0 text-xs text-[var(--color-neutral-500)]">{item.sublabel}</span>
            )}
          </label>
          {item.trailing && <div className="shrink-0">{item.trailing}</div>}
        </div>
      ))}
    </div>
  );
}
