"use client";

import type { ReactNode } from "react";

export function AuthCard({
  icon,
  title,
  subtitle,
  children,
  footer,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div
            className="mb-4 flex items-center justify-center bg-[var(--color-accent-800)] border border-[var(--color-accent-600)] text-[var(--color-accent)]"
            style={{ width: 44, height: 44, borderRadius: "var(--radius-md)" }}
          >
            {icon}
          </div>
          <h1 className="text-xl font-semibold text-[var(--color-text)]">{title}</h1>
          <p className="mt-1 text-sm text-[var(--color-neutral-500)]">{subtitle}</p>
        </div>

        <div
          className="border border-[var(--color-divider)] bg-[var(--color-surface)] p-6"
          style={{ borderRadius: "var(--radius-lg)" }}
        >
          {children}
        </div>

        {footer && <div className="mt-5 text-center text-sm text-[var(--color-neutral-500)]">{footer}</div>}
      </div>
    </div>
  );
}
