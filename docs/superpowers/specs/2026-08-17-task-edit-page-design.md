# Task edit page — design spec

**Date:** 2026-08-17
**Status:** approved

## Problem

Once a task is created, its spec fields (title, description, acceptance criteria, area, codebase) are permanently read-only on `/tasks/[taskId]` — there is no way to fix a typo, tighten the description, or adjust acceptance criteria before a run starts. Only the Assignee field (PR #94) has an inline editor today. This is a real gap, not one covered by any existing or planned feature — confirmed by searching all local and remote branches, all GitHub issues, and `ARCHITECTURE.md`.

## Goal

Let a task's spec fields be edited before its session starts, reachable via a pencil icon on the detail page.

## Scope

- New route: `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx`
- `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` — pencil icon next to the title, linking to the edit route
- `apps/web/src/lib/icons.tsx` — add `PencilSimple as EditIcon` to the barrel
- `apps/web/src/lib/i18n/dictionaries/en.ts` (+ `paths.ts` typed keys, auto-derived) — new `taskDetail.edit*` / `tasks.edit.*` strings

## Out of scope

- Assignee and Model fields — already have dedicated editors (Assignee dropdown on the detail page; Model has no editor at all today and isn't part of this feature).
- Editing after a session exists — same rule as the Assignee dropdown: once `task.sessionId` is set, the spec was already handed to that session, so it reverts to read-only.
- Any change to `PATCH /api/tasks/[taskId]` — it already accepts an arbitrary partial body via `updateTask(id, body)`; no backend change needed.

## Design decisions

- **Separate route, not inline.** Unlike Assignee/Status (single-field, single-control edits), this form touches five fields at once including two multi-line ones — a dedicated page keeps the detail page simple and reuses the New Task form's existing layout conventions almost verbatim.
- **Pre-session only.** Matches the Assignee dropdown's existing rule and rationale: a running or completed session already captured a fixed spec, so editing it afterward wouldn't move or restart anything.
- **Acceptance criteria: preserve `done` state by text match.** The New Task form already represents criteria as one-line-per-item in a `Textarea`; the edit page reuses that same textarea convention rather than a structured line-item editor (add/remove/reorder controls), keeping the form consistent with New Task. Preserving `done` state is the one deviation needed from New Task's raw-textarea approach, since New Task has no existing state to lose and edit does.

## Mechanism

### Guard

On load, if `task.sessionId` is set, redirect to `/tasks/[taskId]` immediately (same as a not-found task redirects there today) — no edit form is ever shown for a task with a session.

### Pencil affordance

On `page.tsx`, next to the `<h1>{task.title}</h1>`, render:

```tsx
{!task.sessionId && (
  <Link href={`/tasks/${task.id}/edit`} aria-label={t("taskDetail.editTask")}>
    <EditIcon size={16} />
  </Link>
)}
```

### Form

Mirrors `tasks/new/page.tsx`'s structure and shared components (`TextInput`, `Textarea`, `Field`, `PageHeader`, `Breadcrumb` from `@agentfactory/shared`), pre-filled from the loaded task:

| Field | Component | Source / notes |
|---|---|---|
| Title | `TextInput`, required | `task.title` |
| Description | `Textarea` | `task.description` |
| Acceptance criteria | `Textarea`, one line per item | `task.acceptanceCriteria.map(c => c.text).join("\n")` |
| Area | `TextInput` | `task.area ?? ""` |
| Codebase | `<select>` from `/api/connections/github/repos` | same fetch pattern as New Task; pre-selected to `task.codebase` |

No Assignee or Model fields on this page.

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
  title: title.trim(),
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
- **Session starts in another tab while the edit form is open:** the save call still succeeds (`PATCH` has no session guard, matching today's Assignee-edit behavior) — accepted as consistent with the existing race-condition tolerance elsewhere on this page, not a new gap introduced by this feature.
- **Codebase repo list empty:** same empty-state link to `/connections` as New Task.

## Testing

- Manual verification in the browser (dev server): pencil visible only pre-session, edit form pre-fills correctly, save round-trips through `updateTask` and lands back on the detail page with updated fields, acceptance-criteria done-state survives an edit that only tweaks the description.
- No existing test infra covers `tasks/new/page.tsx` today (no test file for it in the repo), so no dedicated test file is added for the edit page either, consistent with current coverage conventions for this route group.

## Implementation plan / PR split

Single PR — new page plus small edits to two existing files:

1. `apps/web/src/lib/icons.tsx` — add `EditIcon`.
2. `apps/web/src/lib/i18n/dictionaries/en.ts` — new strings.
3. `apps/web/src/app/(app)/tasks/[taskId]/page.tsx` — pencil icon.
4. `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx` — new edit form.
