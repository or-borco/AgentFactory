"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/AuthCard";
import { Button, TextInput } from "@/components/ui";
import { ArrowLeftIcon, CheckIcon, MailIcon } from "@/lib/icons";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);

  return (
    <AuthCard
      icon={<MailIcon className="h-5 w-5" />}
      title="Reset password"
      subtitle="We'll send you a link to reset it"
      footer={
        <Link href="/login" className="inline-flex items-center gap-1.5 font-medium text-indigo-600 hover:text-indigo-500">
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          Back to log in
        </Link>
      }
    >
      {sent ? (
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckIcon className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-slate-900">Check your email</p>
          <p className="text-sm text-slate-500">We&apos;ve sent a reset link if that address has an account.</p>
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
            <label className="mb-1.5 block text-sm font-medium text-slate-700">Email address</label>
            <TextInput type="email" placeholder="you@example.com" icon={<MailIcon className="h-4 w-4" />} required />
          </div>
          <Button type="submit" className="w-full justify-center">
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
