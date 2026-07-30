"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { Button, TextInput } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { LockIcon, MailIcon, UserIcon } from "@/lib/icons";

function UserPlusIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  );
}

export default function RegisterPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("auth.passwordMismatch"));
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch("/api/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) });
      router.push("/agents");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.genericError"));
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      icon={<UserPlusIcon className="h-5 w-5" />}
      title={t("auth.register.title")}
      subtitle={t("auth.register.subtitle")}
      footer={
        <>
          {t("auth.register.haveAccount")}{" "}
          <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-500">
            {t("auth.register.logIn")}
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">{t("auth.nameLabel")}</label>
          <TextInput
            type="text"
            placeholder={t("auth.namePlaceholder")}
            icon={<UserIcon className="h-4 w-4" />}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">{t("auth.emailLabel")}</label>
          <TextInput
            type="email"
            placeholder={t("auth.emailPlaceholder")}
            icon={<MailIcon className="h-4 w-4" />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">{t("auth.passwordLabel")}</label>
          <TextInput
            type="password"
            placeholder={t("auth.passwordPlaceholder")}
            icon={<LockIcon className="h-4 w-4" />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">{t("auth.confirmPasswordLabel")}</label>
          <TextInput
            type="password"
            placeholder={t("auth.passwordPlaceholder")}
            icon={<LockIcon className="h-4 w-4" />}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" className="w-full justify-center" disabled={submitting}>
          {submitting ? t("auth.register.submitting") : t("auth.register.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
