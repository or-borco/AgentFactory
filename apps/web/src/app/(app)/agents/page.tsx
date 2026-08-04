"use client";

import { useRouter } from "next/navigation";
import { Button, EmptyState } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { BotIcon } from "@/lib/icons";

export default function AgentsPage() {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <EmptyState
      icon={<BotIcon size={28} />}
      title={t("legacyAgents.heading")}
      subtitle={t("legacyAgents.body")}
      action={
        <Button variant="primary" onClick={() => router.push("/teams-v2")}>
          {t("legacyAgents.cta")}
        </Button>
      }
    />
  );
}
