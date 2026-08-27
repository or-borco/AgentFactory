"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EvalRequirement, Run, RunEval, RunStatus } from "@agentfactory/core";
import { EmptyState } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import type { TranslationKey } from "@/lib/i18n/paths";

// Segment ids come from prompt-composition.ts — team_context and agent_system_prompt are the
// only two the eval judge ever grades against (see RunEvalResult.layers). Same fallback
// treatment as RunContextPanel: unrecognised ids fall through to a generic label.
const LAYER_LABEL_KEYS: Record<string, TranslationKey> = {
  team_context: "taskDetail.contextLayerTeamContext",
  agent_system_prompt: "taskDetail.contextLayerAgentSystemPrompt",
};

// error column values → copy, explicit for all five codes the worker stores. Unknown codes
// (any future reason) fall through to the generic line.
const ERROR_LABEL_KEYS: Record<string, TranslationKey> = {
  run_never_composed_prompt: "taskDetail.evalErrorRunNeverComposedPrompt",
  no_human_context: "taskDetail.evalErrorNoHumanContext",
  artefact_unavailable: "taskDetail.evalErrorArtefactUnavailable",
  insufficient_credit: "taskDetail.evalErrorInsufficientCredit",
  judge_error: "taskDetail.evalErrorGeneric",
};

// Keyed on the verdict union so a new verdict is a compile error here, never a blank mark.
const VERDICT_LABEL_KEYS: Record<EvalRequirement["verdict"], TranslationKey> = {
  pass: "taskDetail.evalVerdictPass",
  fail: "taskDetail.evalVerdictFail",
  unclear: "taskDetail.evalVerdictUnclear",
  overridden: "taskDetail.evalVerdictOverridden",
};

// "overridden" takes the neutral colour deliberately: nobody did anything wrong, so it must
// not read as a miss at a glance.
const VERDICT_MARKS: Record<EvalRequirement["verdict"], { mark: string; color: string }> = {
  pass: { mark: "✓", color: "var(--color-success, #22c55e)" },
  fail: { mark: "✗", color: "var(--color-danger, #ef4444)" },
  unclear: { mark: "?", color: "var(--color-neutral-500)" },
  overridden: { mark: "↷", color: "var(--color-neutral-500)" },
};

// Same three statuses RunContextPanel treats as final — the POST guard mirrors this server-side
// (see the TERMINAL_STATUSES set in app/api/runs/[runId]/evals/route.ts).
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "failed", "cancelled"]);
const ACTIVE_EVAL_STATUSES = new Set<RunEval["status"]>(["queued", "running"]);
const POLL_MS = 3000;

type EvalFetchState = { status: "error" } | { status: "loaded"; evals: RunEval[] };

function countVerdicts(runEval: RunEval): { passed: number; total: number; overridden: number } {
  const requirements = runEval.result?.layers.flatMap((layer) => layer.requirements) ?? [];
  // `total` must match the denominator the stored `score` actually used: "unclear" (the
  // artefact didn't show enough to decide) and "overridden" (the user's own request
  // contradicted the instruction, so it never governed the run) are excluded from both sides
  // of that fraction. Counting either one here would make the headline report a shortfall for
  // something that was never actually checked against the run.
  return {
    passed: requirements.filter((r) => r.verdict === "pass").length,
    total: requirements.filter((r) => r.verdict === "pass" || r.verdict === "fail").length,
    overridden: requirements.filter((r) => r.verdict === "overridden").length,
  };
}

export function RunEvalPanel({ runs }: { runs: Run[] }) {
  const { t } = useTranslation();
  // Holds ONLY an explicit pick from the run selector — see RunContextPanel for why this can't
  // be a useState initializer derived from `runs` (the tab can open before the run list loads).
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [evalsByRun, setEvalsByRun] = useState<Map<number, EvalFetchState>>(new Map());
  const [creating, setCreating] = useState(false);
  // A failed POST (e.g. a 409 from a status race between render and click) must never clobber
  // already-loaded history in evalsByRun — that map is what the whole panel renders from. Track
  // creation failures separately, keyed by run, so they only ever affect the Evaluate button's
  // own area and are cleared the moment a later attempt is made.
  const [createErrorRunId, setCreateErrorRunId] = useState<number | null>(null);
  // Guards the initial fetch per run so the effect below never double-requests.
  const requestedRunIds = useRef<Set<number>>(new Set());

  const shownRunId = selectedRunId ?? runs[0]?.id ?? null;
  const shownRun = runs.find((run) => run.id === shownRunId);

  const fetchEvals = useCallback(async (runId: number) => {
    try {
      const evals = await apiFetch<RunEval[]>(`/api/runs/${runId}/evals`);
      setEvalsByRun((prev) => new Map(prev).set(runId, { status: "loaded", evals }));
    } catch {
      setEvalsByRun((prev) => new Map(prev).set(runId, { status: "error" }));
    }
  }, []);

  useEffect(() => {
    if (shownRunId === null || requestedRunIds.current.has(shownRunId)) return;
    requestedRunIds.current.add(shownRunId);
    void fetchEvals(shownRunId);
  }, [shownRunId, fetchEvals]);

  const fetchState = shownRunId !== null ? evalsByRun.get(shownRunId) : undefined;
  const evals = fetchState?.status === "loaded" ? fetchState.evals : [];
  const hasActiveEval = evals.some((e) => ACTIVE_EVAL_STATUSES.has(e.status));

  // Poll only while an eval is queued/running — the card flips to done/failed on its own and
  // the interval is torn down by the effect cleanup below (never a poll that runs forever).
  useEffect(() => {
    if (shownRunId === null || !hasActiveEval) return;
    const timer = setInterval(() => void fetchEvals(shownRunId), POLL_MS);
    return () => clearInterval(timer);
  }, [shownRunId, hasActiveEval, fetchEvals]);

  if (runs.length === 0) {
    return <EmptyState icon="📊" title={t("taskDetail.contextNoRuns")} subtitle={t("taskDetail.evalNoRunsSub")} />;
  }

  const runIsTerminal = shownRun ? TERMINAL_STATUSES.has(shownRun.status) : false;
  const runHasPrompt = Boolean(shownRun?.promptHash);
  const canEvaluate = runIsTerminal && runHasPrompt && !hasActiveEval && !creating;
  const disabledReason = !runIsTerminal
    ? t("taskDetail.evalDisabledNotTerminal")
    : !runHasPrompt
      ? t("taskDetail.evalDisabledNoPrompt")
      : null;

  const startEval = async () => {
    if (shownRunId === null) return;
    setCreating(true);
    setCreateErrorRunId(null);
    try {
      await apiFetch<RunEval>(`/api/runs/${shownRunId}/evals`, { method: "POST" });
      await fetchEvals(shownRunId);
    } catch {
      // Do NOT touch evalsByRun here — it holds already-loaded, valid history for this run,
      // and a failed create (e.g. a 409 because the run wasn't terminal after all) must not
      // replace that with the generic load-error view. Surface the failure locally instead.
      setCreateErrorRunId(shownRunId);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", fontSize: 13 }}>
      {runs.length > 1 && (
        <select
          value={shownRunId ?? undefined}
          onChange={(e) => {
            setSelectedRunId(Number(e.target.value));
            setCreateErrorRunId(null);
          }}
          aria-label={t("taskDetail.contextRunLabel")}
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-divider)",
            borderRadius: "var(--radius-md)",
            color: "var(--color-text)",
            fontSize: 13,
            marginBottom: 16,
            padding: "6px 10px",
          }}
        >
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {t("taskDetail.contextRunLabel")} #{run.id} · {run.status}
            </option>
          ))}
        </select>
      )}

      {fetchState?.status === "error" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <p style={{ color: "var(--color-status-amber)" }}>{t("taskDetail.evalLoadError")}</p>
          <button
            onClick={() => shownRunId !== null && void fetchEvals(shownRunId)}
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
            {t("taskDetail.evalRetry")}
          </button>
        </div>
      ) : (
        <>
          {evals.length === 0 && (
            <p style={{ color: "var(--color-neutral-500)", maxWidth: 560, marginBottom: 12 }}>
              {t("taskDetail.evalIntro")}
            </p>
          )}
          {!hasActiveEval && (
            <div style={{ marginBottom: 20 }}>
              <button
                onClick={() => void startEval()}
                disabled={!canEvaluate}
                style={{
                  background: "var(--color-accent-800)",
                  border: "1px solid var(--color-accent-600)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--color-accent-200)",
                  cursor: canEvaluate ? "pointer" : "not-allowed",
                  fontSize: 13,
                  fontWeight: 500,
                  opacity: canEvaluate ? 1 : 0.45,
                  padding: "8px 16px",
                }}
              >
                {evals.length === 0 ? t("taskDetail.evalButton") : t("taskDetail.evalButtonAgain")}
              </button>
              {disabledReason && (
                <p style={{ color: "var(--color-neutral-500)", marginTop: 6 }}>{disabledReason}</p>
              )}
              {createErrorRunId === shownRunId && (
                <p style={{ color: "var(--color-status-amber)", marginTop: 6 }}>
                  {t("taskDetail.evalErrorGeneric")}
                </p>
              )}
            </div>
          )}
          {evals.map((runEval, index) => (
            <EvalCard key={runEval.id} runEval={runEval} collapsed={index > 0} isFirstOlder={index === 1} />
          ))}
        </>
      )}
    </div>
  );
}

function EvalCard({
  runEval,
  collapsed,
  isFirstOlder,
}: {
  runEval: RunEval;
  collapsed: boolean;
  isFirstOlder: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!collapsed);
  const { passed, total, overridden } = countVerdicts(runEval);

  const headline =
    runEval.status === "queued" || runEval.status === "running"
      ? t("taskDetail.evalRunningLabel")
      : runEval.status === "failed"
        ? t("taskDetail.evalFailedTitle")
        : total === 0
          ? t("taskDetail.evalNoRequirements")
          : t("taskDetail.evalHeadline", { passed, total });

  return (
    <div style={{ border: "1px solid var(--color-divider)", borderRadius: 8, padding: 16, marginBottom: 12 }}>
      {isFirstOlder && (
        <p style={{ color: "var(--color-neutral-500)", margin: "0 0 8px" }}>{t("taskDetail.evalHistoryLabel")}</p>
      )}
      <button
        onClick={() => setOpen((prev) => !prev)}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left" }}
      >
        <span style={{ fontSize: 10, color: "var(--color-neutral-500)" }}>{open ? "▾" : "▸"}</span>
        <span style={{ color: "var(--color-neutral-500)", fontSize: 12 }}>
          <span>{new Date(runEval.createdAt).toLocaleString()}</span>
          {runEval.judgeModelId && (
            <>
              {" · "}
              <span>{t("taskDetail.evalJudgeStamp", { model: runEval.judgeModelId })}</span>
            </>
          )}
        </span>
      </button>

      {open && (
        <p style={{ fontWeight: 600, fontSize: 13, color: "var(--color-text)", margin: "8px 0 0" }}>{headline}</p>
      )}

      {/* The headline's own denominator already excludes overridden requirements, so it can't
          tell a reader that any were set aside. This line is the one place that surfaces it
          without expanding a layer: an override means the user's own request contradicted the
          instruction, so it never governed the run and was left out of the count entirely. */}
      {open && overridden > 0 && (
        <p style={{ color: "var(--color-neutral-500)", margin: "4px 0 0" }}>
          {t("taskDetail.evalOverriddenCount", { count: overridden })}
        </p>
      )}

      {open && runEval.status === "failed" && (
        <p style={{ marginTop: 8 }}>
          {t(ERROR_LABEL_KEYS[runEval.error ?? ""] ?? "taskDetail.evalErrorGeneric")}
        </p>
      )}

      {open && runEval.status === "done" && runEval.result && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: "var(--color-neutral-500)", margin: "0 0 8px" }}>
            {runEval.result.artefactKind === "diff"
              ? t("taskDetail.evalArtefactDiff")
              : t("taskDetail.evalArtefactFinalMessage")}
          </p>
          {runEval.result.truncated && (
            <p style={{ color: "var(--color-status-amber)", margin: "0 0 8px" }}>
              {t("taskDetail.evalTruncated")}
            </p>
          )}
          {runEval.result.layers.map((layer) => (
            <div key={layer.segmentId} style={{ marginBottom: 12 }}>
              <p style={{ fontWeight: 600, margin: "0 0 6px" }}>
                {t(LAYER_LABEL_KEYS[layer.segmentId] ?? "taskDetail.contextLayerUnknown")}
              </p>
              {layer.requirements.map((requirement, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                  <span style={{ color: VERDICT_MARKS[requirement.verdict].color, fontWeight: 700 }}>
                    {VERDICT_MARKS[requirement.verdict].mark}
                  </span>
                  <div>
                    <p style={{ margin: 0 }}>
                      {requirement.text}{" "}
                      <span style={{ color: "var(--color-neutral-500)" }}>—</span>{" "}
                      <span style={{ color: "var(--color-neutral-500)" }}>
                        {t(VERDICT_LABEL_KEYS[requirement.verdict])}
                      </span>
                    </p>
                    {requirement.evidence && (
                      <p style={{ margin: "2px 0 0", color: "var(--color-neutral-500)", fontStyle: "italic" }}>
                        {t("taskDetail.evalEvidenceLabel")}: {requirement.evidence}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
