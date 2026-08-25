import type { ReactNode } from "react";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" }) {
  const tones = {
    neutral: "bg-[color-mix(in_srgb,var(--color-neutral-500)_10%,transparent)] text-[var(--color-neutral-500)]",
    success: "bg-[color-mix(in_srgb,var(--color-status-green)_12%,transparent)] text-[var(--color-status-green)]",
    warning: "bg-[color-mix(in_srgb,var(--color-status-amber)_15%,transparent)] text-[var(--color-status-amber)]",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
