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
      icon={<ArrowRightIcon className="h-5 w-5" />}
      title={t("auth.login.title")}
      subtitle={t("auth.login.subtitle")}
      footer={
        <>
          {t("auth.login.noAccount")}{" "}
          <Link href="/register" className="font-medium text-indigo-600 hover:text-indigo-500">
            {t("auth.login.createOne")}
          </Link>
        </>
      }
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
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
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-medium text-slate-700">{t("auth.passwordLabel")}</label>
            <Link href="/forgot-password" className="text-sm font-medium text-indigo-600 hover:text-indigo-500">
              {t("auth.login.forgotPasswordLink")}
            </Link>
          </div>
          <TextInput
            type="password"
            placeholder={t("auth.passwordPlaceholder")}
            icon={<LockIcon className="h-4 w-4" />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" className="w-full justify-center" disabled={submitting}>
          {submitting ? t("auth.login.submitting") : t("auth.login.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
