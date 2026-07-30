import type { ReactNode } from "react";

export function EmptyState({ icon, title, subtitle, action }: { icon: ReactNode; title: string; subtitle: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-neutral-800)] text-[var(--color-neutral-500)]">{icon}</div>
      <p className="text-base font-semibold text-[var(--color-text)]">{title}</p>
      <p className="max-w-sm text-sm text-[var(--color-neutral-500)]">{subtitle}</p>
      {action}
    </div>
  );
}
