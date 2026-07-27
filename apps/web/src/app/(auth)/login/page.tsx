"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard, AuthDivider } from "@/components/AuthCard";
import { Button, TextInput } from "@/components/ui";
import { useTranslation } from "@/lib/i18n/context";
import { ArrowRightIcon, GoogleIcon, LockIcon, MailIcon } from "@/lib/icons";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useTranslation();

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
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-medium text-slate-700">{t("auth.passwordLabel")}</label>
            <Link href="/forgot-password" className="text-sm font-medium text-indigo-600 hover:text-indigo-500">
              {t("auth.login.forgotPasswordLink")}
            </Link>
          </div>
          <TextInput type="password" placeholder={t("auth.passwordPlaceholder")} icon={<LockIcon className="h-4 w-4" />} required />
        </div>
        <Button type="submit" className="w-full justify-center">
          {t("auth.login.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
