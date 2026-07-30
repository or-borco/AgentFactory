export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return (
    <textarea
      className={`w-full rounded-[var(--radius-md)] border border-[var(--color-divider)] bg-[var(--color-surface)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-neutral-600)] focus:border-[var(--color-accent)] focus:outline-none ${className}`}
      {...rest}
    />
  );
}
