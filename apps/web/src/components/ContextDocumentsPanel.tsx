"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrgMember, TeamContextItem } from "@agentfactory/core";
import { Badge, EmptyState } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

// Mirrors MAX_UPLOAD_BYTES and ALLOWED_MIMES in
// apps/web/src/app/api/teams/[teamId]/context-items/route.ts. The route is the enforcement
// point — a client skipping these still gets a 413/415. These exist only so the two mistakes a
// user actually makes get named copy instead of a generic failure line.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIMES = ["text/markdown", "text/plain"];

// Badge has no danger tone and isn't gaining one here; a failed document carries its message
// inline underneath instead.
const STATUS_TONES: Record<TeamContextItem["status"], "neutral" | "success" | "warning"> = {
  pending: "neutral",
  indexing: "neutral",
  indexed: "success",
  failed: "warning",
};

const STATUS_LABEL_KEYS: Record<TeamContextItem["status"], TranslationKey> = {
  pending: "teamsV2.documentsStatusPending",
  indexing: "teamsV2.documentsStatusIndexing",
  indexed: "teamsV2.documentsStatusIndexed",
  failed: "teamsV2.documentsStatusFailed",
};

const NON_TERMINAL: ReadonlySet<TeamContextItem["status"]> = new Set(["pending", "indexing"]);
const POLL_MS = 3000;

export function ContextDocumentsPanel({ teamId, members }: { teamId: number; members: OrgMember[] }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TeamContextItem[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setItems(await apiFetch<TeamContextItem[]>(`/api/teams/${teamId}/context-items`));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [teamId]);

  useEffect(() => {
    // Initial fetch on mount; load() is async, so any setState it makes lands in a later
    // microtask, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Poll only while something is mid-ingestion. Until the ingest worker lands nothing moves an
  // item off "pending", so on a team with documents this keeps ticking for as long as the tab is
  // open — one small GET every 3s, and it stops itself the moment ingestion exists.
  const anyPending = items.some((item) => NON_TERMINAL.has(item.status));
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyPending, load]);

  async function handleFile(file: File) {
    setErrorKey(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setErrorKey("teamsV2.documentsTooLarge");
      return;
    }
    if (!ALLOWED_MIMES.includes(file.type)) {
      setErrorKey("teamsV2.documentsUnsupportedType");
      return;
    }

    const body = new FormData();
    body.append("file", file);
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
              <div
                key={item.id}
                className={[
                  "flex items-center gap-3 px-4 py-3",
                  i < items.length - 1 ? "border-b border-[var(--color-divider)]" : "",
                ].join(" ")}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-[var(--color-neutral-200)]">{item.title}</div>
                  <div className="text-xs text-[var(--color-neutral-500)]">
                    {t("teamsV2.documentsSize", { size: (item.sizeBytes / 1024).toFixed(1) })}
                    {uploader ? ` · ${t("teamsV2.documentsUploadedBy", { name: uploader.name })}` : ""}
                  </div>
                  {item.status === "failed" && item.error && (
                    <div className="mt-1 text-xs text-red-400">{item.error}</div>
                  )}
                </div>
                <Badge tone={STATUS_TONES[item.status]}>{t(STATUS_LABEL_KEYS[item.status])}</Badge>
                <button
                  onClick={() => void handleDelete(item.id)}
                  className="shrink-0 cursor-pointer text-xs text-[var(--color-neutral-500)] transition-colors hover:text-red-400"
                >
                  {t("teamsV2.documentsDelete")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
