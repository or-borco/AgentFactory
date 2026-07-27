"use client";

import type { ReactNode } from "react";
import { useTranslation } from "@/lib/i18n/context";

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
    <div className="flex min-h-screen items-center justify-center bg-[#f4f5f7] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white">
            {icon}
          </div>
          <h1 className="text-xl font-bold text-slate-900">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>

        {footer && <div className="mt-5 text-center text-sm text-slate-500">{footer}</div>}
      </div>
    </div>
  );
}

export function AuthDivider() {
  const { t } = useTranslation();
  return (
    <div className="my-5 flex items-center gap-3">
      <div className="h-px flex-1 bg-slate-200" />
      <span className="text-xs font-medium text-slate-400">{t("auth.divider")}</span>
      <div className="h-px flex-1 bg-slate-200" />
    </div>
  );
}
