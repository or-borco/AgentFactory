"use client";

import { useRouter } from "next/navigation";
import { Button, EmptyState } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { UsersIcon } from "@/lib/icons";

export default function TeamsPage() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <EmptyState
      icon={<UsersIcon size={28} />}
      title={t("legacyTeams.heading")}
      subtitle={t("legacyTeams.body")}
      action={
        <Button variant="primary" onClick={() => router.push("/teams-v2")}>
          {t("legacyTeams.cta")}
        </Button>
      }
    />
  );
}
