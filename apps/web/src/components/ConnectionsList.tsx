"use client";

import { useState } from "react";
import { Badge, Button, TextInput, Card } from "@agentfactory/shared";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Modal } from "@/components/Modal";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { AlertIcon, LinkIcon, TrashIcon } from "@/lib/icons";
import { useMockBackend } from "@/lib/mock/context";
import type { TranslationKey } from "@/lib/i18n/paths";
import type { Connection, ConnectionHealth, ConnectionKind } from "@agentfactory/core";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

// Each entry is one "Connect X" action. A redirect action (GitHub today) hands off to a
// server-driven OAuth/install flow; a modal action collects credentials inline. Keeping this as
// data — rather than a hardcoded button per provider — means a future Slack/Monday connect button
// is a new array entry, not another branch through the component.
type ConnectAction =
  | { key: string; kind: "redirect"; labelKey: TranslationKey; href: string }
  | { key: string; kind: "modal"; labelKey: TranslationKey; modal: "jira" };

const CONNECT_ACTIONS: ConnectAction[] = [
  { key: "github", kind: "redirect", labelKey: "connections.connectGithub", href: "/api/connections/github/start" },
  { key: "jira", kind: "modal", labelKey: "connections.jira.connect", modal: "jira" },
];

const inputLabelClass = "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)]";

function JiraConnectModal({
  t,
  onClose,
  onConnected,
}: {
  t: Translate;
  onClose: () => void;
  onConnected: (connection: Connection) => void;
}) {
  const [siteUrl, setSiteUrl] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const connection = await apiFetch<Connection>("/api/connections/jira", {
        method: "POST",
        body: JSON.stringify({ siteUrl, accountEmail, apiToken }),
      });
      onConnected(connection);
    } catch (err) {
      // apiFetch surfaces the route's own { error } message for a 400/409 — fall back to a
      // generic message only when the failure didn't come from the server as a readable string.
      setError(err instanceof Error && err.message ? err.message : t("connections.jira.verifyFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={t("connections.jira.modalTitle")} onClose={onClose}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className={inputLabelClass}>{t("connections.jira.siteUrl")}</label>
          <TextInput
            type="url"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://your-team.atlassian.net"
            required
          />
          <p className="mt-1 text-xs text-[var(--color-neutral-500)]">{t("connections.jira.siteUrlHelp")}</p>
        </div>
        <div>
          <label className={inputLabelClass}>{t("connections.jira.accountEmail")}</label>
          <TextInput type="email" value={accountEmail} onChange={(e) => setAccountEmail(e.target.value)} required />
        </div>
        <div>
          <label className={inputLabelClass}>{t("connections.jira.apiToken")}</label>
          <TextInput type="password" value={apiToken} onChange={(e) => setApiToken(e.target.value)} required />
          <p className="mt-1 text-xs text-[var(--color-neutral-500)]">{t("connections.jira.apiTokenHelp")}</p>
        </div>
        <p className="text-xs text-[var(--color-neutral-500)]">{t("connections.jira.serviceAccountWarning")}</p>
        {error && <p className="text-sm text-[var(--color-status-red)]">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={submitting}>
            {t("connections.jira.connect")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

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
  const { connections, deleteConnection, addConnection } = useMockBackend();
  const { t } = useTranslation();
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null);
  const [activeModal, setActiveModal] = useState<"jira" | null>(null);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text)]">{t("connections.title")}</h2>
          <p className="mt-0.5 text-sm text-[var(--color-neutral-500)]">{t("connections.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {CONNECT_ACTIONS.map((action) => (
            <Button
              key={action.key}
              onClick={() => {
                if (action.kind === "redirect") window.location.href = action.href;
                else setActiveModal(action.modal);
              }}
            >
              <LinkIcon size={15} />
              {t(action.labelKey)}
            </Button>
          ))}
        </div>
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

      {activeModal === "jira" && (
        <JiraConnectModal
          t={t}
          onClose={() => setActiveModal(null)}
          onConnected={(connection) => {
            addConnection(connection);
            setActiveModal(null);
          }}
        />
      )}
    </div>
  );
}
