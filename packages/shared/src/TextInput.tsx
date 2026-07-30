import type { ReactNode } from "react";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  const { icon, className = "", ...rest } = props;
  return (
    <div className="relative">
      {icon && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-neutral-500)]">{icon}</span>}
      <input
        className={`w-full rounded-[var(--radius-md)] border border-[var(--color-divider)] bg-[var(--color-surface)] py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none ${icon ? "pl-9 pr-3" : "px-3"} ${className}`}
        {...rest}
      />
    </div>
  );
}
