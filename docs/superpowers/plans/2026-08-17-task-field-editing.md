# Task Field Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every task field editable from `/tasks/[taskId]` — Title and Status inline and always-available; Description/Acceptance Criteria/Area/Codebase on a new `/tasks/[taskId]/edit` page, available only before a session starts.

**Architecture:** Reuses existing patterns verbatim: the inline `AssigneeSelect`/`StatusMenu` dropdown pattern for Status, a lightweight `useState` toggle for inline Title editing, and the New Task form's layout/components for the new edit page. No backend changes — `PATCH /api/tasks/[taskId]` already accepts an arbitrary partial body via `updateTask(id, body)`.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, `@agentfactory/shared` (Tailwind components), `@agentfactory/core` (domain types), Vitest + Testing Library (for the one file with existing test coverage).

## Global Constraints

- All user-facing strings go through `useTranslation()` / `t()`, sourced from `apps/web/src/lib/i18n/dictionaries/en.ts` — never hardcode UI text (per `CLAUDE.md`).
- Client components never import from `mock-store.ts` directly — use `useMockBackend()` (per `CLAUDE.md`).
- Prefer editing existing files; `packages/shared` components are Tailwind, page-level code in this route group is plain inline `style={{}}` objects — match whichever convention the file you're editing already uses (don't introduce Tailwind classes into `page.tsx`, don't introduce inline styles into `packages/shared`).
- No test infrastructure exists today for `tasks/new/page.tsx` or `tasks/[taskId]/page.tsx` — don't add new test files for the page-level changes in this plan; the one component with existing test coverage (`StatusMenu`) gets its test extended, not replaced.

---

## Task 1: Fix `StatusMenu`'s two pre-existing bugs

`apps/web/src/components/StatusMenu.tsx` is an already-written, currently-uncommitted, currently-unused component (portal-positioned status dropdown, same pattern as `AssigneeSelect`). It has two bugs that predate this plan and must be fixed before it can be wired up in Task 3:

1. It imports `STATUS_STYLES` from `StatusPill.tsx` as a named import, but that constant is module-private there — this fails `tsc --noEmit` today.
2. Its `STATUS_ORDER` list has 7 entries; `TaskStatus` (`packages/core/src/domain.ts:155`) has 9 — `"failed"` and `"cancelled"` (added later, PR #90) are missing.

**Files:**
- Modify: `apps/web/src/components/StatusPill.tsx:3`
- Modify: `apps/web/src/components/StatusMenu.tsx:9-17`
- Test: `apps/web/src/components/__tests__/StatusMenu.test.tsx` (existing, uncommitted)

**Interfaces:**
- Produces: `STATUS_STYLES` (named export from `StatusPill.tsx`, type `Record<TaskStatus, { bg: string; color: string; border: string; label: string }>`) — consumed by `StatusMenu.tsx` (already imports it) and by Task 3.
- Produces: `StatusMenu` component (already defined, signature unchanged) — consumed by Task 3: `<StatusMenu status={TaskStatus} open={boolean} onToggle={() => void} onSelect={(status: TaskStatus) => void} />`.

- [ ] **Step 1: Export `STATUS_STYLES`**

In `apps/web/src/components/StatusPill.tsx`, change line 3 from:

```ts
const STATUS_STYLES: Record<TaskStatus, { bg: string; color: string; border: string; label: string }> = {
```

to:

```ts
export const STATUS_STYLES: Record<TaskStatus, { bg: string; color: string; border: string; label: string }> = {
```

- [ ] **Step 2: Verify the existing test file now compiles and passes**

Run from the repo root: `pnpm exec vitest run --project unit StatusMenu`
Expected: all 6 existing tests in `StatusMenu.test.tsx` PASS (the file only failed before because the import target didn't exist — no other logic changed yet).

- [ ] **Step 3: Extend the status-list test to cover all 9 statuses (write the failing assertion first)**

In `apps/web/src/components/__tests__/StatusMenu.test.tsx`, change the `"lists every status as an option when open"` test from:

```tsx
  it("lists every status as an option when open", () => {
    renderMenu({ open: true });
    const menu = screen.getByRole("menu");
    for (const label of ["Open", "Assigned", "In progress", "Needs input", "PR open", "Review cycle", "Done"]) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
  });
```

to:

```tsx
  it("lists every status as an option when open", () => {
    renderMenu({ open: true });
    const menu = screen.getByRole("menu");
    for (const label of [
      "Open",
      "Assigned",
      "In progress",
      "Needs input",
      "PR open",
      "Review cycle",
      "Done",
      "Failed",
      "Cancelled",
    ]) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
  });
```

- [ ] **Step 4: Run the test to verify it now fails**

Run: `pnpm exec vitest run --project unit StatusMenu`
Expected: FAIL on the new test — `"Failed"` and `"Cancelled"` are not found in the menu, because `STATUS_ORDER` doesn't include those statuses yet.

- [ ] **Step 5: Add the two missing statuses to `STATUS_ORDER`**

In `apps/web/src/components/StatusMenu.tsx`, change lines 9-17 from:

```ts
const STATUS_ORDER: TaskStatus[] = [
  "open",
  "assigned",
  "in_progress",
  "needs_input",
  "pr_open",
  "review_cycle",
  "done",
];
```

to:

```ts
const STATUS_ORDER: TaskStatus[] = [
  "open",
  "assigned",
  "in_progress",
  "needs_input",
  "pr_open",
  "review_cycle",
  "done",
  "failed",
  "cancelled",
];
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run --project unit StatusMenu`
Expected: all 6 tests PASS (the 6th now asserts 9 labels instead of 7).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors referencing `StatusMenu.tsx` or `StatusPill.tsx` (this was the only pre-existing typecheck failure in the working tree).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/StatusPill.tsx apps/web/src/components/StatusMenu.tsx apps/web/src/components/__tests__/StatusMenu.test.tsx
git commit -m "Fix StatusMenu: export STATUS_STYLES, add failed/cancelled to STATUS_ORDER"
```

---

## Task 2: Add `EditIcon` and new i18n strings

Scaffolding consumed by Tasks 3-6: the pencil icon and every new user-facing string. No logic in this task — verified by typecheck, not a unit test.

**Files:**
- Modify: `apps/web/src/lib/icons.tsx`
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts:234-256` (the `taskDetail` block) and `:193-219` (the `tasks.create` block, to add a sibling `tasks.edit` block after it)

**Interfaces:**
- Produces: `EditIcon` — a React component, same call signature as the existing `CheckIcon`/`TrashIcon`/`XIcon` (`size`, `color`, `weight` props from `@phosphor-icons/react`). Consumed by Tasks 3, 4, 6.
- Produces: i18n keys `taskDetail.editTask`, `taskDetail.editTitle`, `taskDetail.saveTitle`, `taskDetail.cancelEditTitle`, `tasks.edit.title`, `tasks.edit.subtitle`, `tasks.edit.submit`, `tasks.edit.saving`. Consumed by Tasks 3, 4, 5, 6 via `t("...")`. These become valid `TranslationKey` values automatically (`paths.ts`'s `Paths<Dictionary>` type is derived from `en.ts`'s shape — no separate type file to touch).

- [ ] **Step 1: Add `EditIcon` to the icons barrel**

In `apps/web/src/lib/icons.tsx`, add `PencilSimple as EditIcon,` to the re-export list (anywhere among the existing `export { ... } from "@phosphor-icons/react";` names — e.g. right after `Trash as TrashIcon,`):

```ts
  Trash as TrashIcon,
  PencilSimple as EditIcon,
```

- [ ] **Step 2: Add the new `taskDetail` strings**

In `apps/web/src/lib/i18n/dictionaries/en.ts`, inside the `taskDetail` object, change (lines 255-256):

```ts
    contextIncluded: "Team context included",
  },
```

to:

```ts
    contextIncluded: "Team context included",
    editTask: "Edit task details",
    editTitle: "Edit title",
    saveTitle: "Save title",
    cancelEditTitle: "Cancel editing title",
  },
```

- [ ] **Step 3: Add the new `tasks.edit` block**

In the same file, inside the `tasks` object, change (lines 217-220 — the first `    },` closes `create`, the following `  },` closes `tasks`):

```ts
      submit: "Create task",
      cancel: "Cancel",
    },
  },
```

to:

```ts
      submit: "Create task",
      cancel: "Cancel",
    },
    edit: {
      title: "Edit task",
      subtitle: "Update the task's details",
      submit: "Save changes",
      saving: "Saving…",
    },
  },
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no new errors. (`EditIcon` and the new `t()` keys aren't consumed by anything yet, so this just confirms the dictionary and icon barrel are syntactically valid.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/icons.tsx apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "Add EditIcon and i18n strings for task field editing"
```

---

## Task 3: Wire up `StatusMenu` on the task detail page

Replaces the static `StatusPill` in the ref/status row with the interactive `StatusMenu`, so status is editable regardless of session state.

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/[taskId]/page.tsx`

**Interfaces:**
- Consumes: `StatusMenu` from Task 1 (`@/components/StatusMenu`), `updateTask(taskId: number, patch: Partial<Task>) => Promise<void>` (already destructured from `useMockBackend()` at line 38 of this file).
- Produces: nothing new consumed by later tasks — self-contained.

- [ ] **Step 1: Swap the `StatusPill` import for `StatusMenu`, add the `TaskStatus` type import**

Change line 9 from:

```ts
import { StatusPill } from "@/components/StatusPill";
```

to:

```ts
import { StatusMenu } from "@/components/StatusMenu";
```

Change line 14 from:

```ts
import type { Run } from "@agentfactory/core";
```

to:

```ts
import type { Run, TaskStatus } from "@agentfactory/core";
```

- [ ] **Step 2: Add `statusMenuOpen` state and a `handleStatusChange` handler**

Add to the state block (after the existing `const [savingAssignee, setSavingAssignee] = useState(false);` line):

```ts
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
```

Add a handler near the existing `handleAssigneeChange` (defined around line 244-255, right after the `contextByRun`/`errorsByRun` block):

```ts
  const handleStatusChange = async (status: TaskStatus) => {
    if (!task) return;
    setStatusMenuOpen(false);
    await updateTask(task.id, { status });
  };
```

- [ ] **Step 3: Replace the `<StatusPill>` render with `<StatusMenu>`**

Change:

```tsx
              <StatusPill
                status={task.status}
                label={t(`tasks.status.${task.status}` as `tasks.status.${typeof task.status}`)}
              />
```

to:

```tsx
              <StatusMenu
                status={task.status}
                open={statusMenuOpen}
                onToggle={() => setStatusMenuOpen((v) => !v)}
                onSelect={handleStatusChange}
              />
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors. (`StatusPill` import removal must not leave it referenced anywhere else in the file — it isn't; confirmed no other usage exists.)

- [ ] **Step 5: Manual verification**

Run: `pnpm dev` (or use the already-running dev server), open `http://localhost:3000/tasks`.

1. Open any task (e.g. one showing "Assigned" in the list). On the detail page, the status badge next to the `T-xxx` ref should now be a clickable button (border + background matching the status color, same visual as before).
2. Click it — a dropdown opens listing all 9 statuses (Open, Assigned, In progress, Needs input, PR open, Review cycle, Done, Failed, Cancelled).
3. Click "Done" — the dropdown closes, the pill updates to "Done", and the change persists on reload.
4. Repeat on a task that already has a session (e.g. one showing "Failed" or "Done" in the list, which has run before) — confirm the dropdown still opens and works there too (status is not session-gated).

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(app)/tasks/[taskId]/page.tsx"
git commit -m "Wire up StatusMenu on the task detail page"
```

---

## Task 4: Add inline title editing on the task detail page

Pencil next to the `h1` toggles it into an editable text field, saved on Enter, discarded on Escape — always available regardless of session state.

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/[taskId]/page.tsx`

**Interfaces:**
- Consumes: `EditIcon`, `XIcon` from `@/lib/icons` (`CheckIcon` already imported at line 12); `updateTask` (already in scope from Task 3).
- Produces: a module-level `titleButtonStyle: React.CSSProperties` constant, placed alongside the file's other small helpers (`SectionLabel`, `Dim`, `Mono`, `MetaRow`, currently at lines 1111-1145) — used only within this task, not consumed elsewhere.

- [ ] **Step 1: Import `EditIcon` and `XIcon`**

Change line 12 from:

```ts
import { CheckIcon, TrashIcon } from "@/lib/icons";
```

to:

```ts
import { CheckIcon, TrashIcon, EditIcon, XIcon } from "@/lib/icons";
```

- [ ] **Step 2: Add title-editing state and a ref for autofocus**

Add to the state block (after the `statusMenuOpen` line added in Task 3):

```ts
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
```

- [ ] **Step 3: Autofocus the input when editing starts**

Add near the file's other small `useEffect`s (e.g. right after the "Tick once a second while a run is in flight" effect, around line 271-275):

```ts
  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);
```

- [ ] **Step 4: Add the save handler**

Add next to `handleStatusChange` (from Task 3):

```ts
  const handleTitleSave = async () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!task || !next || next === task.title) return;
    await updateTask(task.id, { title: next });
  };
```

- [ ] **Step 5: Replace the static `<h1>` with the toggle**

Change:

```tsx
            <h1 style={{ marginTop: 14, fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>
              {task.title}
            </h1>
```

to:

```tsx
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
              {editingTitle ? (
                <>
                  <input
                    ref={titleInputRef}
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleTitleSave();
                      if (e.key === "Escape") setEditingTitle(false);
                    }}
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      lineHeight: 1.3,
                      flex: 1,
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-neutral-700)",
                      borderRadius: "var(--radius-sm)",
                      color: "var(--color-text)",
                      padding: "2px 8px",
                    }}
                  />
                  <button onClick={handleTitleSave} aria-label={t("taskDetail.saveTitle")} style={titleButtonStyle}>
                    <CheckIcon size={16} />
                  </button>
                  <button onClick={() => setEditingTitle(false)} aria-label={t("taskDetail.cancelEditTitle")} style={titleButtonStyle}>
                    <XIcon size={16} />
                  </button>
                </>
              ) : (
                <>
                  <h1 style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>{task.title}</h1>
                  <button
                    onClick={() => {
                      setTitleDraft(task.title);
                      setEditingTitle(true);
                    }}
                    aria-label={t("taskDetail.editTitle")}
                    style={titleButtonStyle}
                  >
                    <EditIcon size={14} />
                  </button>
                </>
              )}
            </div>
```

- [ ] **Step 6: Add the `titleButtonStyle` helper**

Add next to the file's other small helpers — immediately before `function SectionLabel({ children }...)` (currently line 1111):

```ts
const titleButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  background: "transparent",
  border: "none",
  padding: 2,
  color: "var(--color-neutral-500)",
  cursor: "pointer",
};

```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors.

- [ ] **Step 8: Manual verification**

Using the already-running (or freshly started) dev server at `http://localhost:3000/tasks`:

1. Open a task. Next to the title, a small pencil icon appears.
2. Click it — the title becomes an editable text input, autofocused, with its current text selected/positioned for editing, plus a checkmark and an X button.
3. Change the text and press Enter — the input closes, the new title shows as plain text, and reloading the page shows the change persisted.
4. Click the pencil again, change the text, and press Escape — the original title is restored, unchanged.
5. Click the pencil, clear the field entirely, and press Enter — the editor closes and the title reverts to its previous value (empty titles are rejected).
6. Repeat step 2-3 on a task that already has a session — confirm the pencil and inline edit still work there (title is not session-gated).

- [ ] **Step 9: Commit**

```bash
git add "apps/web/src/app/(app)/tasks/[taskId]/page.tsx"
git commit -m "Add inline title editing on the task detail page"
```

---

## Task 5: Create the task edit page

New route for Description, Acceptance Criteria, Area, and Codebase — available only before a session exists. Mirrors `tasks/new/page.tsx`'s form almost verbatim.

**Files:**
- Create: `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx`

**Interfaces:**
- Consumes: `getTask(id: number) => Task | undefined` and `updateTask(taskId: number, patch: Partial<Task>) => Promise<void>` from `useMockBackend()`; `apiFetch<T>(url: string) => Promise<T>` from `@/lib/api-client`; `Button`, `Breadcrumb`, `PageHeader`, `TextInput`, `Textarea` from `@agentfactory/shared`.
- Produces: the route `/tasks/[taskId]/edit`, linked to by Task 6.

- [ ] **Step 1: Write the page**

Create `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Breadcrumb, PageHeader, TextInput, Textarea } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useMockBackend } from "@/lib/mock/context";
import { useTranslation } from "@/lib/i18n/context";

interface RepoOption {
  id: number;
  fullName: string;
}

export default function EditTaskPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const router = useRouter();
  const { getTask, updateTask } = useMockBackend();
  const { t } = useTranslation();

  const task = getTask(Number(taskId));

  const [description, setDescription] = useState("");
  const [criteriaRaw, setCriteriaRaw] = useState("");
  const [area, setArea] = useState("");
  const [codebase, setCodebase] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(true);

  // Pre-fill the form once the task loads — getTask() can return undefined for a moment
  // after navigation, before MockBackendProvider's initial fetch resolves.
  useEffect(() => {
    if (!task || initialized) return;
    setDescription(task.description);
    setCriteriaRaw(task.acceptanceCriteria.map((c) => c.text).join("\n"));
    setArea(task.area ?? "");
    setCodebase(task.codebase ?? "");
    setInitialized(true);
  }, [task, initialized]);

  // Editing only makes sense before a session exists — once one does, the spec was
  // already handed to it, so bounce back to the read-only detail page.
  useEffect(() => {
    if (task?.sessionId) router.replace(`/tasks/${task.id}`);
  }, [task, router]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<RepoOption[]>("/api/connections/github/repos")
      .then((result) => {
        if (!cancelled) setRepos(result);
      })
      .finally(() => {
        if (!cancelled) setReposLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!task) {
    return <div style={{ padding: "40px", color: "var(--color-neutral-500)" }}>Task not found.</div>;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!task) return;
    setSubmitting(true);
    try {
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
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: "40px 40px 0", maxWidth: 680 }}>
      <Breadcrumb label={task.ref} href={`/tasks/${task.id}`} />

      <div style={{ marginTop: 20 }}>
        <PageHeader title={t("tasks.edit.title")} subtitle={t("tasks.edit.subtitle")} />
      </div>

      <form onSubmit={handleSubmit} style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 20 }}>
        <Field label={t("tasks.create.descriptionLabel")}>
          <Textarea
            placeholder={t("tasks.create.descriptionPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </Field>

        <Field label={t("tasks.create.criteriaLabel")}>
          <Textarea
            placeholder={t("tasks.create.criteriaPlaceholder")}
            value={criteriaRaw}
            onChange={(e) => setCriteriaRaw(e.target.value)}
            rows={4}
          />
          <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>One criterion per line.</p>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label={t("tasks.create.areaLabel")}>
            <TextInput
              placeholder={t("tasks.create.areaPlaceholder")}
              value={area}
              onChange={(e) => setArea(e.target.value)}
            />
          </Field>
          <Field label={t("tasks.create.codebaseLabel")}>
            <select value={codebase} onChange={(e) => setCodebase(e.target.value)} style={selectStyle(!!codebase)}>
              <option value="">
                {reposLoading ? t("tasks.create.codebaseLoading") : t("tasks.create.codebasePlaceholder")}
              </option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}
            </select>
            {!reposLoading && repos.length === 0 && (
              <p style={{ marginTop: 4, fontSize: 12, color: "var(--color-neutral-500)" }}>
                {t("tasks.create.codebaseEmpty")}{" "}
                <Link href="/connections" style={{ color: "var(--color-accent-2)" }}>
                  {t("tasks.create.codebaseEmptyLink")}
                </Link>
              </p>
            )}
          </Field>
        </div>

        <div style={{ display: "flex", gap: 10, paddingBottom: 40 }}>
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? t("tasks.edit.saving") : t("tasks.edit.submit")}
          </Button>
          <Link href={`/tasks/${task.id}`}>
            <Button variant="secondary" type="button">
              {t("tasks.create.cancel")}
            </Button>
          </Link>
        </div>
      </form>
    </div>
  );
}

function selectStyle(hasValue: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--color-neutral-700)",
    background: "var(--color-surface)",
    color: hasValue ? "var(--color-text)" : "var(--color-neutral-500)",
    fontSize: 13,
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: "var(--color-neutral-300)", letterSpacing: "0.01em" }}>
        {label}
      </label>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Using the dev server:

1. Find a task with no session yet (e.g. one showing "Assigned" in the `/tasks` list, or check via the detail page that the "Run agent" button is present, which only shows pre-session). Note its ID from the URL on its detail page (`/tasks/<id>`).
2. Navigate directly to `/tasks/<id>/edit`. The form loads with Description, Acceptance criteria, Area, and Codebase pre-filled from the task's current values.
3. Change the description, add a new line to the acceptance criteria textarea, and click "Save changes" — you land back on `/tasks/<id>` with the updated description showing, and the criteria list has one more item than before (new item unchecked, any pre-existing checked items still checked).
4. Navigate back to `/tasks/<id>/edit`, click "Cancel" — you land back on the detail page with no changes made.
5. Find a task that already has a session (e.g. one showing "Failed" or "Done" in the list). Navigate directly to `/tasks/<that-id>/edit` by typing the URL — you're immediately redirected to `/tasks/<that-id>` (the edit page never renders its form for a task with a session).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx"
git commit -m "Add task edit page for description, criteria, area, and codebase"
```

---

## Task 6: Add the edit-details pencil link on the detail page

The last piece connecting the two: a pencil in the ref/status row that opens `/tasks/[taskId]/edit`, shown only pre-session.

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/[taskId]/page.tsx`

**Interfaces:**
- Consumes: `EditIcon` (already imported in Task 4), the `/tasks/[taskId]/edit` route (created in Task 5).

- [ ] **Step 1: Add the pencil link next to `StatusMenu`**

Change (the block produced by Task 3's Step 3):

```tsx
              <StatusMenu
                status={task.status}
                open={statusMenuOpen}
                onToggle={() => setStatusMenuOpen((v) => !v)}
                onSelect={handleStatusChange}
              />
            </div>
```

to:

```tsx
              <StatusMenu
                status={task.status}
                open={statusMenuOpen}
                onToggle={() => setStatusMenuOpen((v) => !v)}
                onSelect={handleStatusChange}
              />
              {!task.sessionId && (
                <Link
                  href={`/tasks/${task.id}/edit`}
                  aria-label={t("taskDetail.editTask")}
                  style={{ display: "flex", color: "var(--color-neutral-500)" }}
                >
                  <EditIcon size={14} />
                </Link>
              )}
            </div>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Using the dev server:

1. Open a task with no session (e.g. the same one used in Task 5's verification). In the ref/status row (next to the `T-xxx` badge and the status dropdown), a second pencil icon now appears.
2. Click it — you land on `/tasks/<id>/edit` with the form pre-filled (Task 5's page).
3. Open a task that already has a session (e.g. one showing "Failed" or "Done"). The second pencil is not present in that row — only the `T-xxx` badge and the status dropdown are there. The title's own pencil (from Task 4) is still present and still works, confirming only the spec-fields pencil is session-gated.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/tasks/[taskId]/page.tsx"
git commit -m "Add edit-details pencil link to the task detail page"
```

---

## Final check

- [ ] Run the full unit suite once more to confirm nothing else broke: `pnpm test:unit` from the repo root.
- [ ] Run `pnpm --filter @agentfactory/web typecheck` and `pnpm --filter @agentfactory/web lint` one final time across all changed files.
- [ ] Walk through the six manual-verification scripts above in one sitting on a freshly started dev server, since each task's verification was written assuming only that task's changes were live.
