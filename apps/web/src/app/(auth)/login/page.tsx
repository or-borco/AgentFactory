"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { Button, TextInput } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { ArrowRightIcon, LockIcon, MailIcon } from "@/lib/icons";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      router.push("/agents");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.genericError"));
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      icon={<ArrowRightIcon size={18} />}
      title={t("auth.login.title")}
      subtitle={t("auth.login.subtitle")}
      footer={
        <>
          {t("auth.login.noAccount")}{" "}
          <Link href="/register" className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-300)]">
            {t("auth.login.createOne")}
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
            {t("auth.emailLabel")}
          </label>
          <TextInput
            type="email"
            placeholder={t("auth.emailPlaceholder")}
            icon={<MailIcon size={15} />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
              {t("auth.passwordLabel")}
            </label>
            <Link href="/forgot-password" className="text-xs font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-300)]">
              {t("auth.login.forgotPasswordLink")}
            </Link>
          </div>
          <TextInput
            type="password"
            placeholder={t("auth.passwordPlaceholder")}
            icon={<LockIcon size={15} />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm" style={{ color: "#e06060" }}>{error}</p>}
        <Button type="submit" className="w-full justify-center" disabled={submitting}>
          {submitting ? t("auth.login.submitting") : t("auth.login.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
