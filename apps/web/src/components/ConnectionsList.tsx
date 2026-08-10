"use client";

import { useState } from "react";
import { Badge, Button, Card } from "@agentfactory/shared";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useTranslation } from "@/lib/i18n/context";
import { AlertIcon, LinkIcon, TrashIcon } from "@/lib/icons";
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

function ConnectionRow({ conn, t, onDisconnect }: { conn: Connection; t: Translate; onDisconnect: () => void }) {
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
      <div className="flex items-center gap-3">
        <Badge tone={healthTone(conn.health)}>
          <span className="flex items-center gap-1">
            {conn.health === "needs-attention" && <AlertIcon size={11} />}
            {t(`connections.health.${conn.health}`)}
          </span>
        </Badge>
        <button
          type="button"
          onClick={onDisconnect}
          aria-label={t("connections.disconnect")}
          className="text-[var(--color-neutral-500)] transition-colors hover:text-[var(--color-status-red)]"
        >
          <TrashIcon size={16} />
        </button>
      </div>
    </Card>
  );
}

// The interactive body of the Connections surface — extracted so it can be embedded inside
// /settings (see apps/web/src/app/(app)/settings/page.tsx) rather than living on its own route.
export function ConnectionsList() {
  const { connections, deleteConnection } = useMockBackend();
  const { t } = useTranslation();
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text)]">{t("connections.title")}</h2>
          <p className="mt-0.5 text-sm text-[var(--color-neutral-500)]">{t("connections.subtitle")}</p>
        </div>
        <Button onClick={() => (window.location.href = "/api/connections/github/start")}>
          <LinkIcon size={15} />
          {t("connections.connectGithub")}
        </Button>
      </div>

      {SECTIONS.map(({ kind, labelKey }) => {
        const items = connections.filter((c) => c.kind === kind);
        if (items.length === 0) return null;
        return (
          <div key={kind} className="pt-6">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]">
              {t(labelKey)}
            </h3>
            <div className="space-y-2">
              {items.map((conn) => (
                <ConnectionRow key={conn.id} conn={conn} t={t} onDisconnect={() => setPendingDelete(conn)} />
              ))}
            </div>
          </div>
        );
      })}

      {connections.length === 0 && (
        <Card className="mt-6 px-5 py-10 text-center text-sm text-[var(--color-neutral-500)]">
          {t("connections.subtitle")}
        </Card>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("connections.confirmDisconnectTitle", { label: pendingDelete.label })}
          message={t("connections.confirmDisconnectMessage")}
          confirmLabel={t("connections.disconnect")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            deleteConnection(pendingDelete.id);
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}
