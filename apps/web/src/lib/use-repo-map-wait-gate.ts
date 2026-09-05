"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface MapStatusResponse {
  mapped: boolean;
  checkable: boolean;
}

export type RepoMapGateState = "hidden" | "checking" | "prompt" | "waiting";
export type RepoMapWaitFallback = "enqueue-failed" | "poll-failed";

export interface RepoMapWaitGate {
  state: RepoMapGateState;
  fallbackMessage: RepoMapWaitFallback | null;
  startWaiting: () => void;
  startNow: () => void;
}

const POLL_INTERVAL_MS = 2500;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

function fetchStatus(codebase: string): Promise<MapStatusResponse> {
  return apiFetch<MapStatusResponse>(`/api/repos/map-status?codebase=${encodeURIComponent(codebase)}`);
}

// Drives the wait-choice banner's state machine, shared by the task-creation and task-edit
// forms. See docs/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md. `onProceed` is
// called exactly once per "it's fine to submit now" moment: a checkable+mapped initial check, a
// poll landing, or either fallback path — the caller (a form's submit handler) decides what
// "proceed" means (POST vs PATCH).
export function useRepoMapWaitGate(codebase: string, onProceed: () => void): RepoMapWaitGate {
  const [checkedCodebase, setCheckedCodebase] = useState(codebase);
  const [state, setState] = useState<RepoMapGateState>(() => (codebase ? "checking" : "hidden"));
  const [fallbackMessage, setFallbackMessage] = useState<RepoMapWaitFallback | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestIdRef = useRef(0);
  const onProceedRef = useRef(onProceed);

  // Keep the latest onProceed without making it an effect dependency (a fresh inline callback
  // on every render must not restart the fetch/poll effect below).
  useEffect(() => {
    onProceedRef.current = onProceed;
  });

  // Reset synchronously during render when the selected codebase changes, following React's
  // "adjusting state when a prop changes" pattern (https://react.dev/learn/you-might-not-need-an-effect)
  // rather than resetting from inside an effect — so a stale prompt/waiting banner for the
  // *previous* codebase never renders, even for a frame. The actual network check (and tearing
  // down any in-flight poll from the previous codebase, via the effect's cleanup) happens below.
  if (codebase !== checkedCodebase) {
    setCheckedCodebase(codebase);
    setFallbackMessage(null);
    setState(codebase ? "checking" : "hidden");
  }

  function stopPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  // Performs the actual check. requestIdRef guards against a stale response landing after the
  // user has already changed the selection again.
  useEffect(() => {
    stopPolling();
    if (!codebase) return;
    const requestId = ++requestIdRef.current;
    fetchStatus(codebase)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setState(result.checkable && !result.mapped ? "prompt" : "hidden");
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setState("hidden");
      });
    return () => {
      requestIdRef.current += 1;
      stopPolling();
    };
  }, [codebase]);

  function startNow() {
    stopPolling();
    setState("hidden");
    onProceedRef.current();
  }

  function startWaiting() {
    setState("waiting");
    setFallbackMessage(null);

    apiFetch("/api/repos/map-status", { method: "POST", body: JSON.stringify({ codebase }) }).catch(() => {
      setFallbackMessage("enqueue-failed");
      startNow();
    });

    let consecutiveFailures = 0;
    pollTimerRef.current = setInterval(() => {
      fetchStatus(codebase)
        .then((result) => {
          consecutiveFailures = 0;
          if (result.mapped) startNow();
        })
        .catch(() => {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            setFallbackMessage("poll-failed");
            startNow();
          }
        });
    }, POLL_INTERVAL_MS);
  }

  return { state, fallbackMessage, startWaiting, startNow };
}
