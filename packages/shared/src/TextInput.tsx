import type { ReactNode } from "react";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  const { icon, className = "", ...rest } = props;
  return (
    <div className="relative">
      {icon && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">{icon}</span>}
      <input
        className={`w-full rounded-lg border border-slate-200 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 ${icon ? "pl-9 pr-3" : "px-3"} ${className}`}
        {...rest}
      />
    </div>
  );
}
