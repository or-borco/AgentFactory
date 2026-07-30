import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between px-10 pt-10">
      <div>
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-[var(--color-text)]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-[var(--color-neutral-500)]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
