"use client";

import { Badge, Button, Card, PageHeader } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import { AlertIcon, LinkIcon, PlusIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";
import type { TranslationKey } from "@/lib/i18n/paths";
import type { Connection, ConnectionHealth, ConnectionKind } from "@agentfactory/core";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function healthTone(health: ConnectionHealth) {
  if (health === "healthy") return "success" as const;
  if (health === "needs-attention") return "warning" as const;
  return "neutral" as const;
}

const SECTIONS: { kind: ConnectionKind; labelKey: TranslationKey }[] = [
  { kind: "channel", labelKey: "connections.kind.channel" },
  { kind: "scm", labelKey: "connections.kind.scm" },
  { kind: "tasks", labelKey: "connections.kind.tasks" },
];

function ConnectionRow({ conn, t }: { conn: Connection; t: Translate }) {
  return (
    <Card className="flex items-center justify-between px-5 py-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
          <LinkIcon className="h-4.5 w-4.5" />
        </div>
        <p className="text-sm font-semibold text-slate-900">
          {t(`connections.provider.${conn.provider}`)} · {conn.label}
        </p>
      </div>
      <Badge tone={healthTone(conn.health)}>
        <span className="flex items-center gap-1">
          {conn.health === "needs-attention" && <AlertIcon className="h-3 w-3" />}
          {t(`connections.health.${conn.health}`)}
        </span>
      </Badge>
    </Card>
  );
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

      {SECTIONS.map(({ kind, labelKey }) => {
        const items = connections.filter((c) => c.kind === kind);
        if (items.length === 0) return null;
        return (
          <div key={kind} className="px-10 pt-8">
            <h2 className="mb-3 text-base font-semibold text-slate-900">{t(labelKey)}</h2>
            <div className="space-y-2">
              {items.map((conn) => (
                <ConnectionRow key={conn.id} conn={conn} t={t} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
