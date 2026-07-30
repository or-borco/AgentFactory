import type { ReactNode } from "react";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" }) {
  const tones = {
    neutral: "bg-[rgba(147,151,171,0.1)] text-[var(--color-neutral-500)]",
    success: "bg-[rgba(78,202,139,0.12)] text-[#4eca8b]",
    warning: "bg-[rgba(232,164,74,0.15)] text-[#e8a44a]",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
