export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const base = "inline-flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-[var(--color-accent-800)] border border-[var(--color-accent-600)] text-[var(--color-accent-200)] rounded-[var(--radius-sm)] hover:bg-[var(--color-accent-700)]"
      : "border border-[var(--color-divider)] text-[var(--color-neutral-400)] rounded-[var(--radius-sm)] hover:border-[var(--color-neutral-600)] hover:text-[var(--color-neutral-200)]";
  return (
    <button className={`${base} ${styles} ${className}`} {...props}>
      {children}
    </button>
  );
}
