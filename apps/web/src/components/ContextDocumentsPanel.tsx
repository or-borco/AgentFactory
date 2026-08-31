"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { OrgMember, TeamContextItem } from "@agentfactory/core";
import { Badge, EmptyState } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import {
  CONTEXT_ITEM_STATUS_LABEL_KEYS,
  CONTEXT_ITEM_STATUS_TONES,
  hasPendingIngest,
} from "@/lib/context-item-status";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

// Mirrors MAX_UPLOAD_BYTES and ALLOWED_MIMES in
// apps/web/src/app/api/teams/[teamId]/context-items/route.ts. The route is the enforcement
// point — a client skipping these still gets a 413/415. These exist only so the two mistakes a
// user actually makes get named copy instead of a generic failure line.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIMES = ["text/markdown", "text/plain"];

// Some OS/browser combinations never populate `file.type` for a .md file — it comes through as
// "" locally, or as "application/octet-stream" once a File round-trips through FormData. That
// would reject this feature's own headline scenario, so a file whose declared mime isn't in
// ALLOWED_MIMES gets a second chance based on its extension before being turned away.
function extensionMime(filename: string): "text/markdown" | "text/plain" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return null;
}

// Matches RunEvalPanel's cadence — the same "a worker is doing something we can't be told
// about" problem, and the same answer.
const POLL_MS = 3000;

export function ContextDocumentsPanel({
  teamId,
  members = [],
}: {
  teamId: number;
  members?: OrgMember[];
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TeamContextItem[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await apiFetch<TeamContextItem[]>(`/api/teams/${teamId}/context-items`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [teamId]);

  useEffect(() => {
    // Initial fetch on mount; reload() is async, so any setState it makes lands in a later
    // microtask, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  // Ingestion runs in apps/worker with no push channel back to this tab, so a document that
  // was "Queued" a second ago has no way to say it reached "Indexed". Poll — but only while
  // something can still move, so a settled list (and the empty list a team sits on before its
  // first upload) costs nothing.
  useEffect(() => {
    if (!hasPendingIngest(items)) return;
    const timer = setInterval(() => {
      void reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [items, reload]);

  async function handleFile(file: File) {
    setErrorKey(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setErrorKey("teamsV2.documentsTooLarge");
      return;
    }
    let mime = file.type;
    if (!ALLOWED_MIMES.includes(mime)) {
      const fallback = extensionMime(file.name);
      if (!fallback) {
        setErrorKey("teamsV2.documentsUnsupportedType");
        return;
      }
      mime = fallback;
    }

    // The route reads its mime straight off the File instance in the multipart body, so once
    // `mime` diverges from `file.type` (the extension-fallback path) the simplest way to hand the
    // server the corrected value — simpler than a separate form field it would have to prefer
    // over `file.type` — is to reconstruct the File with that type before appending it.
    const uploadFile = mime === file.type ? file : new File([file], file.name, { type: mime });
    const body = new FormData();
    body.append("file", uploadFile);
    body.append("title", file.name);
    setUploading(true);
    try {
      const item = await apiFetch<TeamContextItem>(`/api/teams/${teamId}/context-items`, {
        method: "POST",
        body,
      });
      setItems((prev) => [...prev, item]);
    } catch {
      // The route's 4xx bodies are English server copy; rendering them raw would route around
      // t(), so every server-side rejection lands on one translated line. The duplicate case is
      // the likely one, which is why the copy names it.
      setErrorKey("teamsV2.documentsUploadFailed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleDelete(itemId: number) {
    setErrorKey(null);
    try {
      await apiFetch<void>(`/api/teams/${teamId}/context-items/${itemId}`, { method: "DELETE" });
      setItems((prev) => prev.filter((item) => item.id !== itemId));
    } catch {
      setErrorKey("teamsV2.documentsDeleteFailed");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex cursor-pointer items-center justify-center rounded-[var(--radius-md)] border border-dashed border-[var(--color-divider)] px-4 py-6 text-sm text-[var(--color-neutral-500)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-neutral-300)]">
        {uploading ? t("teamsV2.documentsUploading") : t("teamsV2.documentsDropHint")}
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          aria-label={t("teamsV2.documentsUpload")}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </label>

      <p className="text-xs text-[var(--color-neutral-600)]">{t("teamsV2.documentsHelp")}</p>
      {errorKey && <p className="text-xs text-red-400">{t(errorKey)}</p>}
      {loadError && <p className="text-xs text-red-400">{t("teamsV2.documentsLoadError")}</p>}

      {items.length === 0 ? (
        <EmptyState
          icon="📄"
          title={t("teamsV2.documentsEmpty")}
          subtitle={t("teamsV2.documentsEmptySub")}
        />
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-divider)]">
          {items.map((item, i) => {
            const uploader = members.find((m) => m.userId === item.uploadedBy);
            return (
              <Fragment key={item.id}>
                <div
                  className={i < items.length - 1 ? "border-b border-[var(--color-divider)]" : ""}
                >
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-[var(--color-neutral-200)]">{item.title}</div>
                      <div className="text-xs text-[var(--color-neutral-500)]">
                        {t("teamsV2.documentsSize", { size: (item.sizeBytes / 1024).toFixed(1) })}
                        {uploader ? ` · ${t("teamsV2.documentsUploadedBy", { name: uploader.name })}` : ""}
                      </div>
                    </div>
                    <Badge tone={CONTEXT_ITEM_STATUS_TONES[item.status]}>
                      {t(CONTEXT_ITEM_STATUS_LABEL_KEYS[item.status])}
                    </Badge>
                    <button
                      onClick={() => void handleDelete(item.id)}
                      className="shrink-0 cursor-pointer text-xs text-[var(--color-neutral-500)] transition-colors hover:text-red-400"
                    >
                      {t("teamsV2.documentsDelete")}
                    </button>
                  </div>
                  {item.status === "failed" && item.error ? (
                    <p className="px-4 pb-3 text-[11px] text-red-400">
                      {t("teamsV2.documentErrorPrefix", { error: item.error })}
                    </p>
                  ) : null}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
