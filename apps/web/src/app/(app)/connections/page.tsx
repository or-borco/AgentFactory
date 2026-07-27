"use client";

import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { useTranslation } from "@/lib/i18n/context";
import { AlertIcon, LinkIcon, PlusIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";
import type { ConnectionHealth } from "@agentfactory/core";

function healthTone(health: ConnectionHealth) {
  if (health === "healthy") return "success" as const;
  if (health === "needs-attention") return "warning" as const;
  return "neutral" as const;
}

export default function ConnectionsPage() {
  const { connections, notify } = useMockBackend();
  const { t } = useTranslation();

  return (
    <div className="pb-16">
      <PageHeader
        title={t("connections.title")}
        subtitle={t("connections.subtitle")}
        action={
          <Button onClick={() => notify("toast.connectProviderComingSoon")}>
            <PlusIcon className="h-4 w-4" />
            {t("connections.newConnection")}
          </Button>
        }
      />

      <div className="space-y-2 px-10 pt-8">
        {connections.map((conn) => (
          <Card key={conn.id} className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                <LinkIcon className="h-4.5 w-4.5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  {t(`connections.provider.${conn.provider}`)} · {conn.label}
                </p>
                <p className="text-xs text-slate-500">{t(`connections.kind.${conn.kind}`)}</p>
              </div>
            </div>
            <Badge tone={healthTone(conn.health)}>
              <span className="flex items-center gap-1">
                {conn.health === "needs-attention" && <AlertIcon className="h-3 w-3" />}
                {t(`connections.health.${conn.health}`)}
              </span>
            </Badge>
          </Card>
        ))}
      </div>
    </div>
  );
}
