# Repo map wait — progress indicator design

## Problem

The wait-choice banner's "waiting" state (`RepoMapWaitBanner`, `state === "waiting"`) currently shows a single static sentence — "Preparing repo context… Usually takes about 30 seconds…" — for the entire duration of the wait, which is commonly 30+ seconds (generation alone measures 33-38s per PR #156's investigation). Nothing on screen changes during that time, so a user watching it has no way to distinguish "working normally" from "stuck."

## Goal

Give the user continuous visual feedback that something is actively happening, without claiming to know real progress the backend doesn't expose today (see "Ground truth" below). The bar for success is reassurance, not accuracy — the user should never wonder whether it's frozen.

## Ground truth

- `GET /api/repos/map-status` (`apps/web/src/app/api/repos/map-status/route.ts`) only ever returns `{ mapped: boolean, checkable: boolean }` — a binary "is it done" signal, polled every 2.5s by `useRepoMapWaitGate`. There is no intermediate stage or percentage available from the backend today.
- The actual warm job (`warmRepoMap` in `apps/worker/src/repo-map.ts:135-168`) does: resolve sha → provision a throwaway sandbox → clone the repo into it (`cloneIntoSandbox`) → run the generation agent turn (`generateAndCacheRepoMap` → `generateRepoMap`) → tear down the sandbox. So sandbox provisioning and cloning are real steps, but per PR #156's own measurements, the generation agent turn alone accounts for 33-38s — the dominant share of total wait time — while provisioning + clone is comparatively quick. There is no distinct "reading the codebase" stage on the worker side; that happens as part of the single generation turn.
- This codebase already has a precedent for this exact kind of indicator: the task detail page's "agent running" indicator (`apps/web/src/app/(app)/tasks/[taskId]/page.tsx`) uses a spinning circular border (`@keyframes spin`, ~14-18px, 1.5px border, `var(--color-accent)` with a transparent top edge) next to status text, plus an elapsed-seconds counter shown after 10s.

## Design

**No backend changes.** This is a client-side-only, purely cosmetic addition to `RepoMapWaitBanner`. The real check/poll/fail-open logic in `useRepoMapWaitGate` is untouched.

**State ownership:** A local 1-second ticker lives inside `RepoMapWaitBanner`, gated on `gate.state === "waiting"`:
- Starts (from 0) the moment `state` becomes `"waiting"`.
- Stops and resets whenever `state` leaves `"waiting"` for any reason (proceeds, escape hatch, fallback message shown, codebase changed causing a reset).
- If `state` re-enters `"waiting"` later (e.g., a fresh wait after a codebase switch), the ticker restarts from 0 — it does not persist across separate waits.

This state is intentionally NOT part of `useRepoMapWaitGate`'s state machine — the hook's job is correctness (is it mapped, should we keep polling, when do we give up), and this ticker has zero bearing on any of that. Keeping it local to the component preserves the existing separation between "pure state machine" and "presentation," which the codebase's own review process has already flagged as worth preserving.

**Visual:** A small spinning circular border (matching the task detail page's existing `spin` keyframe/style exactly, for visual consistency) rendered next to a text label, as a new line below the existing static "Usually takes about 30 seconds…" sentence. The existing sentence is NOT removed — the spinner+label is additive.

**Phases**, selected by elapsed seconds since the ticker started:

| Elapsed | Label |
|---|---|
| 0-5s | "Setting up…" |
| 5-30s | "Generating the map…" |
| 30s+ | "Still working — this one's taking a bit longer…" (terminal — stays here indefinitely rather than looping back or claiming to be almost done) |

These boundaries are a deliberate approximation weighted toward the real proportions (provisioning+clone is quick, generation dominates), not a claim of real per-stage telemetry. The 30s+ phase exists specifically so a wait that runs long (a bigger repo, a slow model call) doesn't strand the user on "Generating the map…" indefinitely with no acknowledgment that it's taking longer than typical — that phase's job is honesty about the overrun, not new information.

**New i18n keys** (`apps/web/src/lib/i18n/dictionaries/en.ts`, under `tasks.repoMapWait`): `progressSettingUp`, `progressGenerating`, `progressTakingLonger` (or similar — exact key names decided during planning).

## Out of scope

- Any backend change to expose real per-stage job status. If a future need arises for genuinely accurate progress, that's a separate, larger design (would need the worker to publish stage transitions somewhere pollable).
- Changing the 2.5s poll interval, the fail-open behavior, or any other part of `useRepoMapWaitGate`'s real state machine.
- An elapsed-time counter (considered and explicitly not chosen — the rotating phase text plus spinner was preferred over a numeric ticking counter).
- Removing or rewording the existing static "Usually takes about 30 seconds…" sentence.

## Testing

- Component test for `RepoMapWaitBanner`: using fake timers, verify the label reads "Setting up…" immediately on entering `"waiting"`, transitions to "Generating the map…" after 5s, and to "Still working — this one's taking a bit longer…" after 30s (and stays there past 30s, e.g. at 60s).
- Verify the ticker resets to phase 1 if the component re-enters `"waiting"` after having left it (e.g. gate transitions waiting → hidden → waiting again).
- No changes needed to `use-repo-map-wait-gate.test.ts` — the hook itself is untouched.

## Manual verification

Since this dev environment has no GitHub App credentials, the full live wait flow can't be exercised end-to-end locally (as already noted for the base feature). The component-level behavior (phase transitions, spinner) can be verified via the component test with fake timers, and visually by manually driving `RepoMapWaitBanner` with a mocked `gate` prop in an ad-hoc render if needed. Full live-flow confirmation happens once this ships to an environment with a real GitHub connection.
