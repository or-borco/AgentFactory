import Link from "next/link";
import type { ReactNode } from "react";

export function Breadcrumb({ href, label, icon }: { href: string; label: string; icon?: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
    >
      {icon}
      {label}
    </Link>
  );
}
