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
  requestSubmit: () => void;
  startWaiting: () => void;
  startNow: () => void;
}

const POLL_INTERVAL_MS = 2500;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
// How long the fallback message stays on screen before the form proceeds anyway. Long enough to
// read one short sentence; the escape hatch still proceeds immediately for anyone who'd rather
// not wait even this long.
const FALLBACK_DISPLAY_MS = 2500;

function fetchStatus(codebase: string): Promise<MapStatusResponse> {
  return apiFetch<MapStatusResponse>(`/api/repos/map-status?codebase=${encodeURIComponent(codebase)}`);
}

// Drives the wait-choice banner's state machine, shared by the task-creation and task-edit forms.
//
// The check runs when the user *attempts to submit* (`requestSubmit`, called by the form's own
// submit handler after its own validation) — never automatically on selection, so a pre-selected
// codebase can't put a banner in front of a user who hasn't asked to submit anything yet.
//
// `onProceed` means "the form should submit now" and is called at most once per submit attempt.
// There are several ways to reach it — a mapped/unresolvable initial check, a poll landing, the
// escape hatch, or a fallback timing out — so every one of them is funnelled through `proceed()`,
// which is guarded by a generation counter. That same counter is bumped whenever the codebase
// changes, so a poll or check started for a previously selected repo can never submit the form
// (or clear a timer) belonging to the current one.
export function useRepoMapWaitGate(codebase: string, onProceed: () => void): RepoMapWaitGate {
  const [activeCodebase, setActiveCodebase] = useState(codebase);
  const [state, setState] = useState<RepoMapGateState>("hidden");
  const [fallbackMessage, setFallbackMessage] = useState<RepoMapWaitFallback | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const onProceedRef = useRef(onProceed);

  // Keep the latest onProceed without making it an effect dependency (a fresh inline callback on
  // every render must not restart anything below).
  useEffect(() => {
    onProceedRef.current = onProceed;
  });

  // Reset synchronously during render when the selected codebase changes, following React's
  // "adjusting state when a prop changes" pattern (https://react.dev/learn/you-might-not-need-an-effect)
  // rather than resetting from inside an effect — so a stale prompt/waiting banner for the
  // *previous* codebase never renders, even for a frame.
  if (codebase !== activeCodebase) {
    setActiveCodebase(codebase);
    setState("hidden");
    setFallbackMessage(null);
  }

  function stopPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  // Clears both timers by touching the refs directly rather than delegating to stopPolling — the
  // exhaustive-deps rule only recognises a helper as ref-only (and so omittable from an effect's
  // dependency list) when it reads refs itself.
  function clearTimers() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }

  // Invalidates everything in flight for the previous selection: the generation bump makes every
  // outstanding callback a no-op, and the timers belong to that selection too.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      clearTimers();
    };
  }, [codebase]);

  // The single door to "the form submits now". Bumping the generation on the way through is what
  // makes it fire at most once per submit attempt, no matter how many callbacks race to reach it.
  function proceed(generation: number) {
    if (generationRef.current !== generation) return;
    generationRef.current += 1;
    clearTimers();
    setState("hidden");
    setFallbackMessage(null);
    onProceedRef.current();
  }

  // Shows the fallback message on the still-visible banner, then proceeds once the user has had a
  // moment to read it.
  function showFallbackThenProceed(generation: number, message: RepoMapWaitFallback) {
    if (generationRef.current !== generation) return;
    stopPolling();
    setState("waiting");
    setFallbackMessage(message);
    if (fallbackTimerRef.current) return;
    fallbackTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = null;
      proceed(generation);
    }, FALLBACK_DISPLAY_MS);
  }

  function requestSubmit() {
    const generation = generationRef.current;
    if (!codebase) {
      proceed(generation);
      return;
    }
    setState("checking");
    setFallbackMessage(null);
    fetchStatus(codebase)
      .then((result) => {
        if (generationRef.current !== generation) return;
        // Fail open: only a definitively-checkable miss is worth interrupting the submit for.
        if (result.checkable && !result.mapped) {
          setState("prompt");
          return;
        }
        proceed(generation);
      })
      .catch(() => proceed(generation));
  }

  // Both choice buttons only mean anything while the banner is actually up; ignoring them
  // otherwise keeps a stray call from starting a submit the user never asked for. Unlike the
  // other proceed() callers, this reads `state` from the render closure rather than a ref, so
  // it can only be stale across a commit boundary — safe for direct click handlers (each click
  // is its own task, always sees a committed `state`), not a substitute for the generation guard
  // if this were ever invoked from inside another async callback's continuation.
  function startNow() {
    if (state !== "prompt" && state !== "waiting") return;
    proceed(generationRef.current);
  }

  function startWaiting() {
    if (state !== "prompt") return;
    const generation = generationRef.current;
    const target = codebase;
    setState("waiting");
    setFallbackMessage(null);

    apiFetch("/api/repos/map-status", { method: "POST", body: JSON.stringify({ codebase: target }) }).catch(() =>
      showFallbackThenProceed(generation, "enqueue-failed"),
    );

    let consecutiveFailures = 0;
    let inFlight = false;
    stopPolling();
    pollTimerRef.current = setInterval(() => {
      // A tick that lands while the previous request is still outstanding is skipped rather than
      // overlapping it — two overlapping ticks could otherwise both resolve `mapped: true`.
      if (inFlight) return;
      inFlight = true;

      // A `checkable: false` response and a thrown request both mean "couldn't determine", so
      // they share one counter.
      function registerFailure() {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          showFallbackThenProceed(generation, "poll-failed");
        }
      }

      fetchStatus(target)
        .then((result) => {
          inFlight = false;
          if (generationRef.current !== generation) return;
          if (!result.checkable) {
            registerFailure();
            return;
          }
          consecutiveFailures = 0;
          if (result.mapped) proceed(generation);
        })
        .catch(() => {
          inFlight = false;
          if (generationRef.current !== generation) return;
          registerFailure();
        });
    }, POLL_INTERVAL_MS);
  }

  return { state, fallbackMessage, requestSubmit, startWaiting, startNow };
}
