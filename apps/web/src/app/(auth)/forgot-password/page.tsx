"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button, TextInput } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { ArrowLeftIcon, CheckIcon, MailIcon } from "@/lib/icons";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const { t } = useTranslation();

  return (
    <AuthCard
      icon={<MailIcon size={18} />}
      title={t("auth.forgotPassword.title")}
      subtitle={t("auth.forgotPassword.subtitle")}
      footer={
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-300)]"
        >
          <ArrowLeftIcon size={13} />
          {t("auth.forgotPassword.backToLogin")}
        </Link>
      }
    >
      {sent ? (
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <div
            className="flex items-center justify-center"
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              background: "rgba(78,202,139,0.12)",
              color: "#4eca8b",
            }}
          >
            <CheckIcon size={18} />
          </div>
          <p className="text-sm font-medium text-[var(--color-text)]">{t("auth.forgotPassword.checkEmailTitle")}</p>
          <p className="text-sm text-[var(--color-neutral-500)]">{t("auth.forgotPassword.checkEmailBody")}</p>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setSent(true);
          }}
        >
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
              {t("auth.emailAddressLabel")}
            </label>
            <TextInput type="email" placeholder={t("auth.emailPlaceholder")} icon={<MailIcon size={15} />} required />
          </div>
          <Button type="submit" className="w-full justify-center">
            {t("auth.forgotPassword.submit")}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
