"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "@/lib/i18n/context";
import { BotIcon, LinkIcon, LogOutIcon, SparklesIcon, UsersIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";
import { useAuth } from "@/lib/auth/context";

export function LeftPane({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { toast } = useMockBackend();
  const { t } = useTranslation();
  const { user, logout } = useAuth();

  const navItems = [
    { href: "/agents", label: t("nav.agents"), icon: BotIcon },
    { href: "/teams", label: t("nav.teams"), icon: UsersIcon },
    { href: "/skills", label: t("nav.skills"), icon: SparklesIcon },
    { href: "/connections", label: t("nav.connections"), icon: LinkIcon },
  ];

  const initials = user.email.slice(0, 2).toUpperCase();

  return (
    <div className="flex min-h-screen bg-[var(--color-bg)]">
      <aside
        className="flex shrink-0 flex-col border-r border-[var(--color-divider)] bg-[var(--color-surface)]"
        style={{ width: 188 }}
      >
        {/* Brand */}
        <div
          className="flex items-center gap-[9px] border-b border-[var(--color-divider)]"
          style={{ padding: "16px 14px 12px" }}
        >
          <div
            className="flex shrink-0 items-center justify-center bg-[var(--color-accent-800)] border border-[var(--color-accent-600)]"
            style={{ width: 26, height: 26, borderRadius: 7 }}
          >
            <BotIcon size={13} style={{ color: "var(--color-accent)" }} />
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--color-text)" }}>
            AgentFactory
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1" style={{ padding: 8 }}>
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className="flex items-center transition-colors"
                style={{
                  gap: 8,
                  padding: "7px 9px",
                  borderRadius: "var(--radius-sm)",
                  marginBottom: 2,
                  fontSize: 13,
                  fontWeight: 500,
                  background: active ? "var(--color-accent-900)" : "transparent",
                  color: active ? "var(--color-accent-300)" : "var(--color-neutral-400)",
                }}
                onMouseEnter={(e) => {
                  if (!active) (e.currentTarget as HTMLElement).style.background = "rgba(145,132,217,0.1)";
                }}
                onMouseLeave={(e) => {
                  if (!active) (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <Icon size={15} style={{ flexShrink: 0 }} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Profile */}
        <div
          className="flex items-center gap-[9px] border-t border-[var(--color-divider)] cursor-pointer"
          style={{ padding: "11px 14px" }}
          onClick={logout}
          title={t("nav.logout")}
        >
          <div
            className="flex shrink-0 items-center justify-center rounded-full bg-[var(--color-neutral-700)]"
            style={{ width: 28, height: 28, fontSize: 10, fontWeight: 700, color: "var(--color-neutral-200)" }}
          >
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate" style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text)" }}>
              {user.email.split("@")[0]}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>
              {t("nav.logout")}
            </div>
          </div>
          <LogOutIcon size={14} style={{ color: "var(--color-neutral-600)", flexShrink: 0 }} />
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>

      {toast && (
        <div
          className="fixed bottom-6 right-6 border border-[var(--color-divider)] bg-[var(--color-surface)] px-4 py-3 text-sm font-medium text-[var(--color-text)]"
          style={{ borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-lg)" }}
        >
          {t(toast)}
        </div>
      )}
    </div>
  );
}
