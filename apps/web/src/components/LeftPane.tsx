"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "@/lib/i18n/context";
import { BotIcon, LinkIcon, SparklesIcon, UsersIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";

export function LeftPane({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { toast } = useMockBackend();
  const { t } = useTranslation();

  const navItems = [
    { href: "/agents", label: t("nav.agents"), icon: BotIcon },
    { href: "/teams", label: t("nav.teams"), icon: UsersIcon },
    { href: "/skills", label: t("nav.skills"), icon: SparklesIcon },
    { href: "/connections", label: t("nav.connections"), icon: LinkIcon },
  ];

  return (
    <div className="flex min-h-screen bg-[#f4f5f7]">
      <aside className="flex w-64 shrink-0 flex-col bg-[#0a0e1a] text-white">
        <div className="flex items-center gap-2.5 px-5 py-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600">
            <BotIcon className="h-4.5 w-4.5 text-white" />
          </div>
          <span className="text-[15px] font-semibold">AgentHub</span>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-white/10 font-medium text-white"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-white/10 px-5 py-4 text-xs text-slate-500">{t("nav.workspaceFooter")}</div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>

      {toast && (
        <div className="fixed bottom-6 right-6 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800 shadow-lg">
          {t(toast)}
        </div>
      )}
    </div>
  );
}
