export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const base = "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors";
  const styles =
    variant === "primary"
      ? "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300"
      : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50";
  return (
    <button className={`${base} ${styles} ${className}`} {...props}>
      {children}
    </button>
  );
}
