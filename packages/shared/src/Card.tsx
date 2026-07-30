import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-[var(--radius-md)] border border-[var(--color-divider)] bg-[var(--color-surface)] ${className}`}>{children}</div>
  );
}
