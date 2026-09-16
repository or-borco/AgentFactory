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

// Read-only helper: `Connection.config` is typed as `Record<string, unknown>` (it's the field
// GET /api/connections returns verbatim to the browser, so it deliberately carries no secret
// shape), so the write-back setting is narrowed defensively rather than cast.
function writeBackComment(conn: Connection): boolean {
  const config = conn.config as { writeBack?: { comment?: boolean } } | undefined;
  return config?.writeBack?.comment ?? true;
}

// Per-connection write-back config, shown only for `kind: "tasks"` connections. Comment-on-PR is
// the only setting there is (Product decision 3: no status transition, not even opt-in).
function TaskWriteBackConfig({
  conn,
  t,
  onUpdated,
}: {
  conn: Connection;
  t: Translate;
  onUpdated: (connection: Connection) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comment = writeBackComment(conn);

  const handleToggle = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<Connection>("/api/connections/jira", {
        method: "PATCH",
        body: JSON.stringify({ connectionId: conn.id, writeBack: { comment: !comment } }),
      });
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("connections.jiraWriteBack.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 border-t border-[var(--color-neutral-800)] pt-3">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-xs font-semibold uppercase tracking-[0.05em] text-[var(--color-neutral-500)] transition-colors hover:text-[var(--color-text)]"
      >
        {t("connections.jiraWriteBack.configureLabel")}
      </button>
      {expanded && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--color-text)]">{t("connections.jiraWriteBack.commentToggleLabel")}</p>
            <p className="mt-0.5 text-xs text-[var(--color-neutral-500)]">{t("connections.jiraWriteBack.commentToggleHelp")}</p>
          </div>
          <input
            type="checkbox"
            checked={comment}
            disabled={saving}
            onChange={handleToggle}
            aria-label={t("connections.jiraWriteBack.commentToggleLabel")}
            className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
          />
        </div>
      )}
      {error && <p className="mt-2 text-xs text-[var(--color-status-red)]">{error}</p>}
    </div>
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

function ConnectionRow({
  conn,
  t,
  onDisconnect,
  onConfigUpdated,
}: {
  conn: Connection;
  t: Translate;
  onDisconnect: () => void;
  onConfigUpdated: (connection: Connection) => void;
}) {
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center justify-between">
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
      </div>
      {conn.kind === "tasks" && <TaskWriteBackConfig conn={conn} t={t} onUpdated={onConfigUpdated} />}
    </Card>
  );
}

// The interactive body of the Connections surface — extracted so it can be embedded inside
// /settings (see apps/web/src/app/(app)/settings/page.tsx) rather than living on its own route.
export function ConnectionsList() {
  const { connections: backendConnections, deleteConnection, addConnection } = useMockBackend();
  const { t } = useTranslation();
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null);
  const [activeModal, setActiveModal] = useState<"jira" | null>(null);
  // useMockBackend() has no updateConnection — the PATCH write-back toggle applies its result
  // over the fetched list locally rather than reaching into the shared client cache.
  const [configOverrides, setConfigOverrides] = useState<Record<number, Connection>>({});
  const connections = backendConnections.map((c) => configOverrides[c.id] ?? c);

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
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  t={t}
                  onDisconnect={() => setPendingDelete(conn)}
                  onConfigUpdated={(updated) => setConfigOverrides((s) => ({ ...s, [updated.id]: updated }))}
                />
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
