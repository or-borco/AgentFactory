"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { TASK_CONTEXT_MIME_CONFIG, isTaskContextMimeAllowed, taskContextExtensionMime } from "@agentfactory/core";
import type { OrgMember, TaskContextItem, TeamContextItem } from "@agentfactory/core";
import { Badge, EmptyState } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import {
  CONTEXT_ITEM_STATUS_LABEL_KEYS,
  CONTEXT_ITEM_STATUS_TONES,
  hasPendingIngest,
} from "@/lib/context-item-status";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

// Which task or team this panel manages documents for. Only the API route base and a handful
// of copy strings that name the scope explicitly ("this team's documents") differ between the
// two — everything else (upload/list/delete logic, polling, status badges) is identical, so
// this is a prop rather than two near-duplicate components.
export type ContextDocumentsScope = { kind: "team"; teamId: number } | { kind: "task"; taskId: number };

// The team and task items tables are structurally identical except for which foreign key they
// carry (teamId vs taskId) — this panel never reads that field, so a union covers both without
// needing a shared core type.
type ContextItem = TeamContextItem | TaskContextItem;

function basePathForScope(scope: ContextDocumentsScope): string {
  return scope.kind === "team"
    ? `/api/teams/${scope.teamId}/context-items`
    : `/api/tasks/${scope.taskId}/context-items`;
}

// The only copy that actually names "team" or "task" explicitly; everything else (help text,
// button labels, size/upload-failed-generic copy) reads fine for either scope unchanged.
const SCOPE_COPY_KEYS: Record<
  ContextDocumentsScope["kind"],
  {
    emptySub: TranslationKey;
    uploadFailed: TranslationKey;
    loadError: TranslationKey;
    unsupportedType: TranslationKey;
  }
> = {
  team: {
    emptySub: "teamsV2.documentsEmptySub",
    uploadFailed: "teamsV2.documentsUploadFailed",
    loadError: "teamsV2.documentsLoadError",
    unsupportedType: "teamsV2.documentsUnsupportedType",
  },
  task: {
    emptySub: "taskDetail.documentsEmptySub",
    uploadFailed: "taskDetail.documentsUploadFailed",
    loadError: "taskDetail.documentsLoadError",
    unsupportedType: "taskDetail.documentsUnsupportedType",
  },
};

// Mirrors MAX_UPLOAD_BYTES and ALLOWED_MIMES in
// apps/web/src/app/api/teams/[teamId]/context-items/route.ts. The route is the enforcement
// point — a client skipping these still gets a 413/415. These exist only so the two mistakes a
// user actually makes get named copy instead of a generic failure line.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const TEAM_ALLOWED_MIMES = ["text/markdown", "text/plain"];

// Some OS/browser combinations never populate `file.type` for a .md file — it comes through as
// "" locally, or as "application/octet-stream" once a File round-trips through FormData. That
// would reject this feature's own headline scenario, so a file whose declared mime isn't in
// TEAM_ALLOWED_MIMES gets a second chance based on its extension before being turned away.
function teamExtensionMime(filename: string): "text/markdown" | "text/plain" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return null;
}

// Team scope keeps its own literal mime set unchanged; task scope reads from the shared table.
// Deliberately not unified — see the design doc's "the teams route does not adopt this table".
function isAllowedMime(scope: ContextDocumentsScope, mime: string): boolean {
  return scope.kind === "task" ? isTaskContextMimeAllowed(mime) : TEAM_ALLOWED_MIMES.includes(mime);
}

function extensionMimeFor(scope: ContextDocumentsScope, filename: string): string | null {
  return scope.kind === "task" ? taskContextExtensionMime(filename) : teamExtensionMime(filename);
}

function acceptFor(scope: ContextDocumentsScope): string {
  if (scope.kind !== "task") return ".md,.markdown,.txt,text/markdown,text/plain";
  const extensions = Object.values(TASK_CONTEXT_MIME_CONFIG).flatMap((config) => config.extensions);
  const mimes = Object.keys(TASK_CONTEXT_MIME_CONFIG);
  return [...extensions, ...mimes].join(",");
}

// Matches RunEvalPanel's cadence — the same "a worker is doing something we can't be told
// about" problem, and the same answer.
const POLL_MS = 3000;

export function ContextDocumentsPanel({
  scope,
  members = [],
}: {
  scope: ContextDocumentsScope;
  members?: OrgMember[];
}) {
  const { t } = useTranslation();
  const copy = SCOPE_COPY_KEYS[scope.kind];
  const basePath = basePathForScope(scope);
  const [items, setItems] = useState<ContextItem[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setItems(await apiFetch<ContextItem[]>(basePath));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [basePath]);

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
    if (!isAllowedMime(scope, mime)) {
      const fallback = extensionMimeFor(scope, file.name);
      if (!fallback) {
        setErrorKey(copy.unsupportedType);
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
      const item = await apiFetch<ContextItem>(basePath, {
        method: "POST",
        body,
      });
      setItems((prev) => [...prev, item]);
    } catch {
      // The route's 4xx bodies are English server copy; rendering them raw would route around
      // t(), so every server-side rejection lands on one translated line. The duplicate case is
      // the likely one, which is why the copy names it.
      setErrorKey(copy.uploadFailed);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleDelete(itemId: number) {
    setErrorKey(null);
    try {
      await apiFetch<void>(`${basePath}/${itemId}`, { method: "DELETE" });
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
          accept={acceptFor(scope)}
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
      {loadError && <p className="text-xs text-red-400">{t(copy.loadError)}</p>}

      {items.length === 0 ? (
        <EmptyState
          icon="📄"
          title={t("teamsV2.documentsEmpty")}
          subtitle={t(copy.emptySub)}
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
