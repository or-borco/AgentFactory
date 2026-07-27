"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard, AuthDivider } from "@/components/AuthCard";
import { Button, TextInput } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { GoogleIcon, LockIcon, MailIcon } from "@/lib/icons";

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
      <button
        type="button"
        onClick={() => router.push("/agents")}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <GoogleIcon className="h-4 w-4" />
        {t("auth.continueWithGoogle")}
      </button>

      <AuthDivider />

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          router.push("/agents");
        }}
      >
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">{t("auth.emailLabel")}</label>
          <TextInput type="email" placeholder={t("auth.emailPlaceholder")} icon={<MailIcon className="h-4 w-4" />} required />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">{t("auth.passwordLabel")}</label>
          <TextInput type="password" placeholder={t("auth.passwordPlaceholder")} icon={<LockIcon className="h-4 w-4" />} required />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">{t("auth.confirmPasswordLabel")}</label>
          <TextInput type="password" placeholder={t("auth.passwordPlaceholder")} icon={<LockIcon className="h-4 w-4" />} required />
        </div>
        <Button type="submit" className="w-full justify-center">
          {t("auth.register.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
