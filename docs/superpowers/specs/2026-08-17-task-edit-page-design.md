# Task field editing (edit page + inline title/status) — design spec

**Date:** 2026-08-17
**Status:** approved

## Problem

Once a task is created, its fields are permanently read-only on `/tasks/[taskId]` — no way to fix a typo in the title, change status, tighten the description, or adjust acceptance criteria. Only the Assignee field (PR #94) has an inline editor today. This is a real gap, not one covered by any existing or planned feature — confirmed by searching all local and remote branches, all GitHub issues, and `ARCHITECTURE.md`.

## Goal

Make every task field editable from the detail page, using the interaction pattern that fits each field:

- **Title** and **Status** are metadata/workflow fields, not content a session executes against — renaming a task or moving its status doesn't retroactively change what an already-running agent was told to do. These are always editable, inline, regardless of session state.
- **Description, Acceptance criteria, Area, Codebase** are the task's *spec* — what a session was actually built from. These stay editable only before a session exists, same rule the Assignee dropdown already follows, and move together to a dedicated edit page (too many fields, two of them multi-line, for a one-off inline control).

## Scope

- New route: `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx` — Description, Acceptance Criteria, Area, Codebase; pre-session only.
- `apps/web/src/app/(app)/tasks/[taskId]/page.tsx`:
  - Inline title editor (pencil toggles `h1` into a `TextInput`, always available).
  - Wire up the existing (currently unused, uncommitted) `StatusMenu` next to `StatusPill`, always available.
  - Edit-details pencil next to the ref/status row, linking to `/edit`, pre-session only.
- `apps/web/src/components/StatusPill.tsx` — export `STATUS_STYLES` (currently module-private; `StatusMenu` already imports it as if it were exported — this is why `StatusMenu.tsx` fails typecheck today).
- `apps/web/src/components/StatusMenu.tsx` — add `"failed"` and `"cancelled"` to `STATUS_ORDER` (written before PR #90 added those two statuses to `TaskStatus`; currently missing them).
- `apps/web/src/components/__tests__/StatusMenu.test.tsx` — extend the "lists every status" test to cover all 9.
- `apps/web/src/lib/icons.tsx` — add `PencilSimple as EditIcon` to the barrel.
- `apps/web/src/lib/i18n/dictionaries/en.ts` (+ `paths.ts` typed keys, auto-derived) — new `taskDetail.edit*` / `tasks.edit.*` strings.

## Out of scope

- Assignee and Model fields — Assignee already has a dedicated editor; Model has no editor at all today and isn't part of this feature.
- The tasks *list* page (`/tasks`) — `StatusMenu`'s own comment says it was originally meant for inline status editing in the table too, but that's a separate, larger change (positioning inside a table row, closing on scroll, etc.). Only the detail page gets an editor in this pass.
- Editing Description/Criteria/Area/Codebase after a session exists — same rule as Assignee: once `task.sessionId` is set, the spec was already handed to that session.
- Any change to `PATCH /api/tasks/[taskId]` — it already accepts an arbitrary partial body via `updateTask(id, body)`; no backend change needed for any field in this spec, including status.

## Design decisions

- **Split by what the field *is*, not a single edit mode.** Title/Status are always-live metadata; Description/Criteria/Area/Codebase are a frozen-at-session-start spec. Forcing both kinds through one "pencil → edit page" flow either wrongly locks title/status pre-session, or wrongly unlocks the spec fields post-session. Splitting them avoids both.
- **Status reuses the existing `StatusMenu`, not a new component.** It already exists (portal-positioned dropdown, matches `AssigneeSelect`'s inline-editor pattern) but was left uncommitted and unwired, with one bug (`STATUS_STYLES` not exported) and one gap (missing `failed`/`cancelled`). Finishing it is less work than building a new status editor, and it's already covered by its own test file.
- **Title is inline, not on the edit page.** A single-field, single-line edit doesn't need a page navigation — same reasoning `AssigneeSelect` and `StatusMenu` already follow.
- **Edit page keeps its pre-session guard.** Matches the Assignee dropdown's existing rule and rationale: a running or completed session already captured a fixed spec, so editing it afterward wouldn't move or restart anything.
- **Acceptance criteria: preserve `done` state by text match.** The New Task form already represents criteria as one-line-per-item in a `Textarea`; the edit page reuses that same textarea convention rather than a structured line-item editor (add/remove/reorder controls), keeping the form consistent with New Task. Preserving `done` state is the one deviation needed from New Task's raw-textarea approach, since New Task has no existing state to lose and edit does.

## Mechanism

### Guard (edit page only)

On load, if `task.sessionId` is set, redirect to `/tasks/[taskId]` immediately (same as a not-found task redirects there today) — no edit form is ever shown for a task with a session. Title and Status editors have no such guard — they render regardless of `sessionId`.

### Title — inline edit

State: `editingTitle: boolean`, `titleDraft: string`. Next to the `<h1>{task.title}</h1>`, a pencil button sets `editingTitle = true` and seeds `titleDraft = task.title`. While editing, the `h1` is replaced with a `TextInput` (autofocused) plus a checkmark/X pair (same visual language as `CheckIcon`/`XIcon` used elsewhere on this page). Enter or the checkmark saves via `updateTask(task.id, { title: titleDraft.trim() })` if non-empty and different from `task.title`, then clears `editingTitle`; Escape or the X clears `editingTitle` without saving.

### Status — inline edit

State: `statusMenuOpen: boolean`. Next to the existing `StatusPill` in the ref/status row, render:

```tsx
<StatusMenu
  status={task.status}
  open={statusMenuOpen}
  onToggle={() => setStatusMenuOpen((v) => !v)}
  onSelect={async (status) => {
    setStatusMenuOpen(false);
    await updateTask(task.id, { status });
  }}
/>
```

This replaces the plain `<StatusPill>` currently rendered there — `StatusMenu` renders its own trigger pill internally (see existing `StatusMenu.tsx`), so the two aren't both needed.

### Edit-details pencil (Description/Criteria/Area/Codebase)

In the same ref/status row, next to the `StatusMenu`:

```tsx
{!task.sessionId && (
  <Link href={`/tasks/${task.id}/edit`} aria-label={t("taskDetail.editTask")}>
    <EditIcon size={14} />
  </Link>
)}
```

### Edit page form

Mirrors `tasks/new/page.tsx`'s structure and shared components (`TextInput`, `Textarea`, `PageHeader`, `Breadcrumb` from `@agentfactory/shared`), pre-filled from the loaded task. `Field` (label + children wrapper) and `selectStyle` are small local helpers in `new/page.tsx`, not exported from `@agentfactory/shared` — the edit page defines its own copies, same as `new/page.tsx` does; there's no existing shared home for them and introducing one isn't needed for two call sites.

| Field | Component | Source / notes |
|---|---|---|
| Description | `Textarea` | `task.description` |
| Acceptance criteria | `Textarea`, one line per item | `task.acceptanceCriteria.map(c => c.text).join("\n")` |
| Area | `TextInput` | `task.area ?? ""` |
| Codebase | `<select>` from `/api/connections/github/repos` | same fetch pattern as New Task; pre-selected to `task.codebase` |

No Title, Assignee, Status, or Model fields on this page — Title and Status are edited inline on the detail page (see above); Assignee already has its own inline editor; Model has no editor at all today.

### Save

```ts
const acceptanceCriteria = criteriaRaw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((text) => {
    const existing = task.acceptanceCriteria.find((c) => c.text === text);
    return { text, done: existing?.done ?? false };
  });

await updateTask(task.id, {
  description: description.trim(),
  acceptanceCriteria,
  area: area.trim() || undefined,
  codebase: codebase || undefined,
});
router.push(`/tasks/${task.id}`);
```

A criterion line that matches an existing entry's text exactly keeps its `done` value; a new line starts unchecked; a removed line is dropped. Matching is a straight string-equality lookup — a duplicate line reuses whichever existing entry `.find` hits first, which is an acceptable edge case (not worth structured item-editing to avoid, per the New Task form's own precedent of not needing it).

### Cancel

Plain `<Link href={`/tasks/${task.id}`}>` back to the detail page — no save call.

## Edge cases

- **Task not found / wrong org:** same handling as the detail page already does (loading/not-found states) — no new logic needed, just reuse via `getTask`.
- **Session starts in another tab while the edit form (or the title/status editors) is open:** the save call still succeeds (`PATCH` has no session guard, matching today's Assignee-edit behavior) — accepted as consistent with the existing race-condition tolerance elsewhere on this page, not a new gap introduced by this feature.
- **Codebase repo list empty:** same empty-state link to `/connections` as New Task.
- **Title saved empty or unchanged:** empty (after trim) is a no-op — closes the editor without calling `updateTask`, same as leaving the value unchanged.
- **Status menu open when the row unmounts (e.g. fast navigation):** `StatusMenu` already handles its own outside-click/cleanup via a `useEffect` cleanup function on the document listener — no additional handling needed here.

## Testing

- `StatusMenu.test.tsx` (existing, currently failing typecheck) — extend the "lists every status as an option when open" test to assert all 9 labels (adding `"Failed"`, `"Cancelled"`) once `STATUS_ORDER` is fixed.
- Manual verification in the browser (dev server):
  - Title: pencil → input appears focused with current title, Enter saves and calls `updateTask`, Escape discards, empty value is rejected.
  - Status: dropdown lists all 9 statuses including Failed/Cancelled, selecting one calls `updateTask` and closes the menu, works whether or not `task.sessionId` is set.
  - Edit-details pencil: visible only when `!task.sessionId`; edit page pre-fills correctly; save round-trips through `updateTask` and lands back on the detail page with updated fields; acceptance-criteria done-state survives an edit that only tweaks the description.
- No existing test infra covers `tasks/new/page.tsx` or `tasks/[taskId]/page.tsx` today (no test files for either in the repo), so no dedicated test file is added for the edit page or the detail-page changes, consistent with current coverage conventions for this route group — `StatusMenu` is the one piece here with pre-existing test infra, so that's what gets extended.

## Implementation plan / PR split

Single PR — new page plus edits to existing files:

1. `apps/web/src/components/StatusPill.tsx` — export `STATUS_STYLES`.
2. `apps/web/src/components/StatusMenu.tsx` — add `"failed"`/`"cancelled"` to `STATUS_ORDER`.
3. `apps/web/src/components/__tests__/StatusMenu.test.tsx` — extend status-list assertion; confirm typecheck now passes.
4. `apps/web/src/lib/icons.tsx` — add `EditIcon`.
5. `apps/web/src/lib/i18n/dictionaries/en.ts` — new strings.
6. `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` — inline title editor, wire up `StatusMenu`, edit-details pencil.
7. `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx` — new edit form (Description/Criteria/Area/Codebase).
