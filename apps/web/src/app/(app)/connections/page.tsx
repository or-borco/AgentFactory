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
        <div
          className="flex items-center justify-center bg-[var(--color-neutral-800)] text-[var(--color-neutral-500)]"
          style={{ width: 40, height: 40, borderRadius: "var(--radius-md)" }}
        >
          <LinkIcon size={16} />
        </div>
        <p className="text-sm font-semibold text-[var(--color-text)]">
          {t(`connections.provider.${conn.provider}`)} · {conn.label}
        </p>
      </div>
      <Badge tone={healthTone(conn.health)}>
        <span className="flex items-center gap-1">
          {conn.health === "needs-attention" && <AlertIcon size={11} />}
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
            <PlusIcon size={15} />
            {t("connections.newConnection")}
          </Button>
        }
      />

      {SECTIONS.map(({ kind, labelKey }) => {
        const items = connections.filter((c) => c.kind === kind);
        if (items.length === 0) return null;
        return (
          <div key={kind} className="px-10 pt-8">
            <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t(labelKey)}</h2>
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
