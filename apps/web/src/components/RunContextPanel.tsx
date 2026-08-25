"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PromptSegment, Run, RunPrompt, RunStatus } from "@agentfactory/core";
import { EmptyState } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

// Segment ids are data (stable, defined in prompt-composition.ts) — labels are copy,
// so the mapping lives here in i18n keys. Unknown ids (future layers) fall through
// to a generic label instead of breaking, per the spec's forward-compatibility rule.
const LAYER_LABEL_KEYS: Record<string, TranslationKey> = {
  platform_preamble: "taskDetail.contextLayerPlatformPreamble",
  environment: "taskDetail.contextLayerEnvironment",
  team_context: "taskDetail.contextLayerTeamContext",
  repo_map: "taskDetail.contextLayerRepoMap",
  agent_system_prompt: "taskDetail.contextLayerAgentSystemPrompt",
};

const OMISSION_LABEL_KEYS: Record<string, TranslationKey> = {
  no_team: "taskDetail.contextOmittedNoTeam",
  empty_shared_context: "taskDetail.contextOmittedEmptySharedContext",
  no_codebase: "taskDetail.contextOmittedNoCodebase",
  repo_map_pending: "taskDetail.contextOmittedRepoMapPending",
};

// A run only gets its segments written in the same statement that flips it to `running`, so a
// null answer for a run that is still in flight means "not yet", not "never". Only these three
// statuses make a null answer final.
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "failed", "cancelled"]);

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

type PromptFetchState = { status: "error" } | { status: "loaded"; prompt: RunPrompt | null };

export function RunContextPanel({ runs }: { runs: Run[] }) {
  const { t } = useTranslation();
  // Holds ONLY an explicit pick from the run selector. The run actually shown is derived
  // below, never stored — the tab can be opened before the page's run list finishes
  // loading, and a useState initializer would freeze `null` in that window and leave the
  // panel permanently blank for the common single-run case (no selector is rendered for
  // one run, so nothing would ever set it).
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [promptsByRun, setPromptsByRun] = useState<Map<number, PromptFetchState>>(new Map());
  const [showRaw, setShowRaw] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Tracks which runs have a fetch in flight (or done) so the effect below never issues a
  // second request for the same run — a plain state check can't do this without itself
  // triggering a synchronous setState-in-effect, which the lint rule (rightly) disallows.
  const requestedRunIds = useRef<Set<number>>(new Set());

  // The run on screen: an explicit pick if there is one, otherwise the newest run — recomputed
  // every render, so it starts working the moment `runs` arrives rather than being frozen at mount.
  const shownRunId = selectedRunId ?? runs[0]?.id ?? null;

  // The status of the run on screen. Drives the retry decision below and is the effect's only
  // other dependency, so a re-request happens on a status transition — not on every 1.5s poll
  // tick (the page re-renders this component on each one with a fresh `runs` array).
  const shownRunStatus = runs.find((run) => run.id === shownRunId)?.status;

  const setPromptState = useCallback((runId: number, state: PromptFetchState) => {
    setPromptsByRun((prev) => new Map(prev).set(runId, state));
  }, []);

  const loadPrompt = useCallback(
    (runId: number, status: RunStatus | undefined) => {
      requestedRunIds.current.add(runId);
      apiFetch<RunPrompt | { segments: null }>(`/api/runs/${runId}/prompt`)
        .then((data) => {
          const prompt = data.segments === null ? null : (data as RunPrompt);
          // "No prompt" is only the final answer for a run that has stopped. For a run still in
          // flight the worker simply hasn't written the segments yet, so forget the request and
          // let the next status change re-ask — otherwise the panel would cache a false negative
          // for the whole mount and claim a healthy run never recorded a prompt.
          if (prompt === null && !TERMINAL_STATUSES.has(status as RunStatus)) {
            requestedRunIds.current.delete(runId);
          }
          setPromptState(runId, { status: "loaded", prompt });
        })
        .catch(() => {
          // A transport failure is never terminal either; the retry button re-asks on demand.
          requestedRunIds.current.delete(runId);
          setPromptState(runId, { status: "error" });
        });
    },
    [setPromptState],
  );

  useEffect(() => {
    if (shownRunId === null || requestedRunIds.current.has(shownRunId)) return;
    loadPrompt(shownRunId, shownRunStatus);
  }, [shownRunId, shownRunStatus, loadPrompt]);

  const state = shownRunId !== null ? promptsByRun.get(shownRunId) : undefined;
  const loading = shownRunId !== null && !state;
  const prompt = state?.status === "loaded" ? state.prompt : null;

  const totalBytes = useMemo(
    () => (prompt ? prompt.segments.reduce((sum, s) => sum + byteLength(s.text), 0) : 0),
    [prompt],
  );

  if (runs.length === 0) {
    return <EmptyState icon="📄" title={t("taskDetail.contextNoRuns")} subtitle={t("taskDetail.contextNoRunsSub")} />;
  }

  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "22px 28px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        {runs.length > 1 && (
          <select
            value={shownRunId ?? undefined}
            onChange={(e) => {
              setSelectedRunId(Number(e.target.value));
              setShowRaw(false);
              setExpandedIds(new Set());
            }}
            aria-label={t("taskDetail.contextRunLabel")}
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-text)",
              fontSize: 13,
              padding: "6px 10px",
            }}
          >
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {`${t("taskDetail.contextRunLabel")} #${run.id} — ${new Date(run.createdAt).toLocaleString()}`}
              </option>
            ))}
          </select>
        )}
        {prompt && (
          <button
            onClick={() => setShowRaw((v) => !v)}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-neutral-400)",
              cursor: "pointer",
              fontSize: 12,
              padding: "6px 10px",
            }}
          >
            {showRaw ? t("taskDetail.contextLayersToggle") : t("taskDetail.contextRawToggle")}
          </button>
        )}
      </div>

      {loading && (
        <p style={{ fontSize: 13, color: "var(--color-neutral-500)" }}>{t("common.loading")}</p>
      )}
      {state?.status === "error" && (
        <p style={{ fontSize: 13, color: "var(--color-status-amber)", display: "flex", alignItems: "center", gap: 10 }}>
          {t("taskDetail.contextLoadError")}
          <button
            onClick={() => shownRunId !== null && loadPrompt(shownRunId, shownRunStatus)}
            style={{
              background: "none",
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-neutral-400)",
              cursor: "pointer",
              fontSize: 12,
              padding: "4px 10px",
            }}
          >
            {t("taskDetail.contextRetry")}
          </button>
        </p>
      )}
      {state?.status === "loaded" && prompt === null && (
        <p style={{ fontSize: 13, color: "var(--color-neutral-500)" }}>{t("taskDetail.contextNoPrompt")}</p>
      )}

      {prompt && showRaw && (
        <div>
          {prompt.promptHash && (
            <p style={{ fontSize: 12, color: "var(--color-neutral-600)", marginBottom: 8, fontFamily: "monospace" }}>
              {t("taskDetail.contextPromptHash")}: {prompt.promptHash}
            </p>
          )}
          <pre
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-divider)",
              borderRadius: "var(--radius-md)",
              color: "var(--color-text)",
              fontSize: 12,
              lineHeight: 1.6,
              overflowX: "auto",
              padding: 16,
              whiteSpace: "pre-wrap",
            }}
          >
            {prompt.segments.map((s) => s.text).join("")}
          </pre>
        </div>
      )}

      {prompt && !showRaw && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {prompt.segments.map((segment, index) => (
            <SegmentRow
              key={`${segment.id}-${index}`}
              segment={segment}
              totalBytes={totalBytes}
              expanded={expandedIds.has(`${segment.id}-${index}`)}
              onToggle={() => toggleExpanded(`${segment.id}-${index}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Shared by both header variants below so the omitted (non-interactive) row keeps exactly the
// same visual treatment as the expandable one.
const HEADER_STYLE = {
  alignItems: "center",
  background: "none",
  color: "var(--color-text)",
  display: "flex",
  fontSize: 13,
  gap: 10,
  padding: "10px 14px",
  textAlign: "left",
  width: "100%",
} as const;

function SegmentRow({
  segment,
  totalBytes,
  expanded,
  onToggle,
}: {
  segment: PromptSegment;
  totalBytes: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const bytes = byteLength(segment.text);
  const omitted = segment.text === "";
  const label = t(LAYER_LABEL_KEYS[segment.id] ?? "taskDetail.contextLayerUnknown");
  const omissionLabel = omitted
    ? t((segment.omittedReason && OMISSION_LABEL_KEYS[segment.omittedReason]) ?? "taskDetail.contextOmittedGeneric")
    : null;

  return (
    <div
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-md)",
        opacity: omitted ? 0.55 : 1,
      }}
    >
      {/* An omitted layer has nothing to expand, so it is a plain row rather than a disabled
          button: a disabled button drops out of the tab order and is announced inconsistently,
          and the omission reason it carries is the entire point of the row. */}
      {omitted ? (
        <div style={{ ...HEADER_STYLE, cursor: "default" }}>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-neutral-500)" }}>{omissionLabel}</span>
        </div>
      ) : (
        <button onClick={onToggle} style={{ ...HEADER_STYLE, border: "none", cursor: "pointer", width: "100%" }}>
          <span style={{ fontSize: 10, color: "var(--color-neutral-500)" }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ fontWeight: 600 }}>{label}</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-neutral-500)" }}>
            {t("taskDetail.contextBytes", {
              bytes: bytes.toLocaleString(),
              percent: totalBytes > 0 ? ((bytes / totalBytes) * 100).toFixed(1) : "0",
            })}
          </span>
        </button>
      )}
      {expanded && !omitted && (
        <pre
          style={{
            borderTop: "1px solid var(--color-divider)",
            color: "var(--color-neutral-300)",
            fontSize: 12,
            lineHeight: 1.6,
            margin: 0,
            maxHeight: 420,
            overflow: "auto",
            padding: "12px 14px",
            whiteSpace: "pre-wrap",
          }}
        >
          {segment.text}
        </pre>
      )}
    </div>
  );
}
