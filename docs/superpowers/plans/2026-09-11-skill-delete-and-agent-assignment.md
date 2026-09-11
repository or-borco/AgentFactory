# Skill Deletion and Multi-Select Agent Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user delete a skill (blocked while any agent is assigned) and multi-select which skills an agent has, or which agents have a skill, from three UI surfaces.

**Architecture:** A new generic `MultiSelectCheckboxList` primitive in `packages/shared`, wrapped by two data-owning `apps/web` components (`AgentSkillsPicker`, `SkillAgentsPicker`) that each call the already-existing `agent_skills` API endpoints per checkbox toggle, plus a `DeleteSkillButton` component that disables itself while the skill is assigned. No new backend code — every mutation this plan's UI performs already has a working, tested API route.

**Tech Stack:** Next.js 16 App Router, React (client components), Tailwind (via CSS variables, no config file), TypeScript, Vitest + `@testing-library/react` for component tests, pnpm workspace (`packages/shared`, `packages/core`, `apps/web`).

## Global Constraints

- No long dashes (em dashes) in any user-facing string or comment this plan adds — use commas or separate sentences instead.
- No new API routes or backend code — this plan is frontend-only.
- Every checkbox toggle persists immediately (no Save button) — matches the existing single-select skill picker's behavior.
- `packages/shared` components stay presentation-only, no `apiFetch`/business logic (existing project rule, see `CLAUDE.md`).

---

### Task 1: `MultiSelectCheckboxList` shared component

**Files:**
- Create: `packages/shared/src/MultiSelectCheckboxList.tsx`
- Modify: `packages/shared/src/index.ts` (add export)
- Test: `packages/shared/src/__tests__/MultiSelectCheckboxList.test.tsx`

**Interfaces:**
- Produces: `MultiSelectItem { id: number; label: string; sublabel?: string; trailing?: React.ReactNode }` and `MultiSelectCheckboxList({ items: MultiSelectItem[]; selectedIds: Set<number>; onToggle: (id: number) => void; disabledIds?: Set<number>; emptyMessage?: string })`, both exported from `@agentfactory/shared`. Every later task in this plan imports these.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/MultiSelectCheckboxList.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiSelectCheckboxList, type MultiSelectItem } from "../MultiSelectCheckboxList";

const ITEMS: MultiSelectItem[] = [
  { id: 1, label: "Code review" },
  { id: 2, label: "Release notes", sublabel: "Draft only" },
];

describe("MultiSelectCheckboxList", () => {
  it("renders the empty message when there are no items", () => {
    render(
      <MultiSelectCheckboxList items={[]} selectedIds={new Set()} onToggle={vi.fn()} emptyMessage="Nothing here" />,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("checks the boxes matching selectedIds", () => {
    render(<MultiSelectCheckboxList items={ITEMS} selectedIds={new Set([2])} onToggle={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: /Code review/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Release notes/ })).toBeChecked();
  });

  it("calls onToggle with the item's id when its checkbox is clicked", () => {
    const onToggle = vi.fn();
    render(<MultiSelectCheckboxList items={ITEMS} selectedIds={new Set()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Code review/ }));
    expect(onToggle).toHaveBeenCalledWith(1);
  });

  it("disables a checkbox whose id is in disabledIds and does not call onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(
      <MultiSelectCheckboxList items={ITEMS} selectedIds={new Set()} onToggle={onToggle} disabledIds={new Set([1])} />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /Code review/ });
    expect(checkbox).toBeDisabled();
    fireEvent.click(checkbox);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("renders the sublabel when present", () => {
    render(<MultiSelectCheckboxList items={ITEMS} selectedIds={new Set()} onToggle={vi.fn()} />);
    expect(screen.getByText("Draft only")).toBeInTheDocument();
  });

  it("renders trailing content for an item", () => {
    const items: MultiSelectItem[] = [{ id: 1, label: "Code review", trailing: <span>v3</span> }];
    render(<MultiSelectCheckboxList items={items} selectedIds={new Set()} onToggle={vi.fn()} />);
    expect(screen.getByText("v3")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentfactory/shared exec vitest run src/__tests__/MultiSelectCheckboxList.test.tsx`
Expected: FAIL — `Cannot find module '../MultiSelectCheckboxList'`

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/MultiSelectCheckboxList.tsx`:

```tsx
import type { ReactNode } from "react";
import { Card } from "./Card";

export interface MultiSelectItem {
  id: number;
  label: string;
  sublabel?: string;
  trailing?: ReactNode;
}

export interface MultiSelectCheckboxListProps {
  items: MultiSelectItem[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  disabledIds?: Set<number>;
  emptyMessage?: string;
}

export function MultiSelectCheckboxList({
  items,
  selectedIds,
  onToggle,
  disabledIds,
  emptyMessage,
}: MultiSelectCheckboxListProps) {
  if (items.length === 0) {
    return (
      <Card className="px-5 py-6 text-center text-sm text-[var(--color-neutral-500)]">{emptyMessage}</Card>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-divider)]">
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`flex items-center gap-3 px-4 py-3 ${
            i < items.length - 1 ? "border-b border-[var(--color-divider)]" : ""
          }`}
        >
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={selectedIds.has(item.id)}
              disabled={disabledIds?.has(item.id)}
              onChange={() => onToggle(item.id)}
              className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-accent-600)] disabled:cursor-not-allowed"
            />
            <span className="truncate text-sm text-[var(--color-text)]">{item.label}</span>
            {item.sublabel && (
              <span className="shrink-0 text-xs text-[var(--color-neutral-500)]">{item.sublabel}</span>
            )}
          </label>
          {item.trailing && <div className="shrink-0">{item.trailing}</div>}
        </div>
      ))}
    </div>
  );
}
```

Modify `packages/shared/src/index.ts` — add this line alongside the other exports:

```ts
export * from "./MultiSelectCheckboxList";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentfactory/shared exec vitest run src/__tests__/MultiSelectCheckboxList.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/MultiSelectCheckboxList.tsx packages/shared/src/index.ts packages/shared/src/__tests__/MultiSelectCheckboxList.test.tsx
git commit -m "feat(shared): add MultiSelectCheckboxList primitive"
```

---

### Task 2: `AgentSkillsPicker` and `AgentSkillsSection` refactor

**Files:**
- Create: `apps/web/src/components/AgentSkillsPicker.tsx`
- Modify: `apps/web/src/components/AgentSkillsSection.tsx` (replace entire contents)
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` (trim `agents.skills`)
- Test: `apps/web/src/components/__tests__/AgentSkillsPicker.test.tsx`

**Interfaces:**
- Consumes: `MultiSelectCheckboxList`, `MultiSelectItem` from `@agentfactory/shared` (Task 1). `apiFetch<T>(path, init?)` from `@/lib/api-client`. `useTranslation()` from `@/lib/i18n/context`. Existing endpoints: `GET /api/agents/{agentId}/skills` → `AssignedSkill[]`, `GET /api/skills` → `Skill[]`, `GET /api/skills/{id}` → `{ skill: Skill; versions: SkillVersion[] }`, `POST /api/agents/{agentId}/skills` body `{ skillId }`, `DELETE /api/agents/{agentId}/skills/{skillId}`, `PATCH /api/agents/{agentId}/skills/{skillId}` body `{ skillVersionId }`.
- Produces: `AgentSkillsPicker({ agentId: number })`, a client component with no other exports. `AgentSkillsSection({ agentId: number })` keeps its existing public signature, used unchanged by `apps/web/src/app/(app)/agents/[agentId]/page.tsx`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/__tests__/AgentSkillsPicker.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { AgentSkillsPicker } from "../AgentSkillsPicker";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const SKILLS: Skill[] = [
  {
    id: 1,
    orgId: 1,
    name: "Code review",
    slug: "code-review",
    description: "",
    source: "authored",
    currentVersionId: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: 2,
    orgId: 1,
    name: "Onboarding",
    slug: "onboarding",
    description: "",
    source: "authored",
    currentVersionId: 20,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: 3,
    orgId: 1,
    name: "Release notes",
    slug: "release-notes",
    description: "",
    source: "authored",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

const ASSIGNED = [
  { agentId: 5, skillId: 1, skillVersionId: 10, skillName: "Code review", skillSlug: "code-review", version: 2 },
];

function mockApi({ assigned = ASSIGNED, skills = SKILLS } = {}) {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve({});
    if (init?.method === "DELETE") return Promise.resolve(undefined);
    if (path === "/api/agents/5/skills") return Promise.resolve(assigned);
    if (path === "/api/skills") return Promise.resolve(skills);
    if (path.startsWith("/api/skills/")) {
      const id = Number(path.split("/").pop());
      return Promise.resolve({ skill: skills.find((s) => s.id === id), versions: [] });
    }
    return Promise.resolve(undefined);
  });
}

function renderPicker() {
  return render(
    <I18nProvider>
      <AgentSkillsPicker agentId={5} />
    </I18nProvider>,
  );
}

beforeEach(() => apiFetchMock.mockReset());

describe("AgentSkillsPicker", () => {
  it("shows every org skill, checked for the ones assigned to this agent", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Code review/ })).toBeChecked());
    expect(screen.getByRole("checkbox", { name: /Onboarding/ })).not.toBeChecked();
  });

  it("assigns a skill when its checkbox is checked", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Onboarding/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /Onboarding/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/5/skills", {
        method: "POST",
        body: JSON.stringify({ skillId: 2 }),
      }),
    );
  });

  it("unassigns a skill when its checkbox is unchecked", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Code review/ })).toBeChecked());

    fireEvent.click(screen.getByRole("checkbox", { name: /Code review/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/5/skills/1", { method: "DELETE" }),
    );
  });

  it("disables an unpublished skill's checkbox and labels it Draft only", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Release notes/ })).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: /Release notes/ })).toBeDisabled();
    expect(screen.getByText("Draft only")).toBeInTheDocument();
  });

  it("shows an error when a toggle fails", async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.reject(new Error("boom"));
      if (path === "/api/agents/5/skills") return Promise.resolve(ASSIGNED);
      if (path === "/api/skills") return Promise.resolve(SKILLS);
      // The already-assigned skill (id 1) triggers a per-skill version lookup on every
      // render of the assigned list; this branch must resolve it the same way mockApi()
      // does, or that lookup rejects with an unhandled promise rejection instead of the
      // toggle failure this test is actually about.
      if (path.startsWith("/api/skills/")) {
        const id = Number(path.split("/").pop());
        return Promise.resolve({ skill: SKILLS.find((s) => s.id === id), versions: [] });
      }
      return Promise.resolve(undefined);
    });
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Onboarding/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /Onboarding/ }));

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: /Onboarding/ })).not.toBeChecked();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentfactory/web exec vitest run src/components/__tests__/AgentSkillsPicker.test.tsx`
Expected: FAIL — `Cannot find module '../AgentSkillsPicker'`

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/AgentSkillsPicker.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Skill, SkillVersion } from "@agentfactory/core";
import { MultiSelectCheckboxList, type MultiSelectItem } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

// Mirrors the AgentSkillSummary shape returned by GET /api/agents/[agentId]/skills
// (packages/db/src/repositories/agent-skills.ts) — kept local rather than imported from
// @agentfactory/db since client components only pull domain shapes from @agentfactory/core.
interface AssignedSkill {
  agentId: number;
  skillId: number;
  skillVersionId: number;
  skillName: string;
  skillSlug: string;
  version: number;
}

export function AgentSkillsPicker({ agentId }: { agentId: number }) {
  const { t } = useTranslation();
  const [assigned, setAssigned] = useState<AssignedSkill[] | null>(null);
  const [allSkills, setAllSkills] = useState<Skill[] | null>(null);
  const [versionsBySkill, setVersionsBySkill] = useState<Record<number, SkillVersion[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busySkillIds, setBusySkillIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const [assignedSkills, skills] = await Promise.all([
        apiFetch<AssignedSkill[]>(`/api/agents/${agentId}/skills`),
        apiFetch<Skill[]>("/api/skills"),
      ]);
      setAssigned(assignedSkills);
      setAllSkills(skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    }
  }, [agentId, t]);

  useEffect(() => {
    // Initial fetch on mount; load() is async, so any setState it makes lands in a later
    // microtask, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Populates the per-row upgrade dropdown: for every assigned skill, fetch that skill's
  // published versions. Runs whenever the assigned list changes (add/remove/upgrade).
  useEffect(() => {
    if (!assigned || assigned.length === 0) return;
    let cancelled = false;
    Promise.all(
      assigned.map(async (a) => {
        const detail = await apiFetch<{ skill: Skill; versions: SkillVersion[] }>(`/api/skills/${a.skillId}`);
        return [a.skillId, detail.versions.filter((v) => v.publishedAt)] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setVersionsBySkill(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [assigned]);

  function withBusy(skillId: number, fn: () => Promise<void>) {
    setError(null);
    setBusySkillIds((prev) => new Set(prev).add(skillId));
    return fn()
      .catch((err) => setError(err instanceof Error ? err.message : t("common.loadError")))
      .finally(() =>
        setBusySkillIds((prev) => {
          const next = new Set(prev);
          next.delete(skillId);
          return next;
        }),
      );
  }

  function handleToggle(skillId: number) {
    const isAssigned = (assigned ?? []).some((a) => a.skillId === skillId);
    return withBusy(skillId, async () => {
      if (isAssigned) {
        await apiFetch(`/api/agents/${agentId}/skills/${skillId}`, { method: "DELETE" });
        setAssigned((prev) => prev?.filter((a) => a.skillId !== skillId) ?? null);
      } else {
        await apiFetch(`/api/agents/${agentId}/skills`, { method: "POST", body: JSON.stringify({ skillId }) });
        await load();
      }
    });
  }

  function handleUpgrade(skillId: number, skillVersionId: number) {
    return withBusy(skillId, async () => {
      await apiFetch(`/api/agents/${agentId}/skills/${skillId}`, {
        method: "PATCH",
        body: JSON.stringify({ skillVersionId }),
      });
      await load();
    });
  }

  const assignedById = new Map((assigned ?? []).map((a) => [a.skillId, a]));

  const items: MultiSelectItem[] = (allSkills ?? []).map((s) => {
    const a = assignedById.get(s.id);
    if (a) {
      return {
        id: s.id,
        label: s.name,
        trailing: (
          <select
            aria-label={t("agents.skills.versionLabel")}
            value={a.skillVersionId}
            disabled={busySkillIds.has(s.id)}
            onChange={(e) => handleUpgrade(s.id, Number(e.target.value))}
            style={{
              padding: "3px 6px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-neutral-700)",
              background: "var(--color-surface)",
              color: "var(--color-text)",
              fontSize: 13,
            }}
          >
            {(versionsBySkill[s.id] ?? []).map((v) => (
              <option key={v.id} value={v.id}>{`v${v.version}`}</option>
            ))}
          </select>
        ),
      };
    }
    return { id: s.id, label: s.name, sublabel: s.currentVersionId ? undefined : t("skills.draftOnlyBadge") };
  });

  const selectedIds = new Set((assigned ?? []).map((a) => a.skillId));
  const draftOnlyIds = (allSkills ?? []).filter((s) => !s.currentVersionId).map((s) => s.id);
  const disabledIds = new Set([...busySkillIds, ...draftOnlyIds]);

  return (
    <div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      <MultiSelectCheckboxList
        items={items}
        selectedIds={selectedIds}
        onToggle={handleToggle}
        disabledIds={disabledIds}
        emptyMessage={t("agents.skills.emptyState")}
      />
    </div>
  );
}
```

Replace the entire contents of `apps/web/src/components/AgentSkillsSection.tsx` with:

```tsx
"use client";

import { AgentSkillsPicker } from "@/components/AgentSkillsPicker";
import { useTranslation } from "@/lib/i18n/context";

export function AgentSkillsSection({ agentId }: { agentId: number }) {
  const { t } = useTranslation();
  return (
    <div className="px-10 pt-8">
      <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t("agents.skills.title")}</h2>
      <AgentSkillsPicker agentId={agentId} />
    </div>
  );
}
```

In `apps/web/src/lib/i18n/dictionaries/en.ts`, find the `agents.skills` block (nested under `agents`, currently):

```ts
    skills: {
      title: "Skills",
      emptyState: "No skills assigned yet.",
      addLabel: "Add skill",
      addPlaceholder: "Select a skill…",
      noAssignableSkills: "All published skills are already assigned.",
      versionLabel: "Version",
      removeButtonLabel: "Remove skill",
    },
```

Replace it with:

```ts
    skills: {
      title: "Skills",
      emptyState: "No skills exist yet.",
      versionLabel: "Version",
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentfactory/web exec vitest run src/components/__tests__/AgentSkillsPicker.test.tsx`
Expected: PASS (5 tests)

Also run typecheck since `en.ts` and a consumer both changed: `pnpm --filter @agentfactory/web exec tsc --noEmit`
Expected: no errors (confirms no other file still references the removed `agents.skills.addLabel` / `addPlaceholder` / `noAssignableSkills` / `removeButtonLabel` keys)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/AgentSkillsPicker.tsx apps/web/src/components/AgentSkillsSection.tsx apps/web/src/components/__tests__/AgentSkillsPicker.test.tsx apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): multi-select agent-skills picker, replacing the single-select dropdown"
```

---

### Task 3: Embed the skills picker in the teams-v2 agent panel

**Files:**
- Modify: `apps/web/src/app/(app)/teams-v2/page.tsx`
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` (add one key)

**Interfaces:**
- Consumes: `AgentSkillsPicker({ agentId: number })` from `@/components/AgentSkillsPicker` (Task 2).

- [ ] **Step 1: Add the i18n key**

In `apps/web/src/lib/i18n/dictionaries/en.ts`, inside the `teamsV2` block, find this line:

```ts
    onContextOverflowFailFast: "Fail (keep assigned model)",
```

Add immediately after it:

```ts
    skillsLabel: "Skills",
```

- [ ] **Step 2: Import `AgentSkillsPicker`**

In `apps/web/src/app/(app)/teams-v2/page.tsx`, find the import block at the top of the file:

```tsx
import { ContextDocumentsPanel } from "@/components/ContextDocumentsPanel";
import { apiFetch } from "@/lib/api-client";
```

Add a new import line between them:

```tsx
import { ContextDocumentsPanel } from "@/components/ContextDocumentsPanel";
import { AgentSkillsPicker } from "@/components/AgentSkillsPicker";
import { apiFetch } from "@/lib/api-client";
```

- [ ] **Step 3: Embed the picker in `AgentDetailPanel`**

In the same file, inside `AgentDetailPanel`, find the "On context overflow" field block (the last field in the scrollable fields `<div>`):

```tsx
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.onContextOverflowLabel")}
          </label>
          <select
            value={onContextOverflow}
            onChange={(e) => setOnContextOverflow(e.target.value as OverflowPolicy)}
            className={selectClassName}
          >
            <option value="fallback">{t("teamsV2.onContextOverflowFallback")}</option>
            <option value="fail_fast">{t("teamsV2.onContextOverflowFailFast")}</option>
          </select>
        </div>
      </div>
```

Insert a new field block right after it, still inside the same scrollable `<div>` (before its closing `</div>`):

```tsx
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.onContextOverflowLabel")}
          </label>
          <select
            value={onContextOverflow}
            onChange={(e) => setOnContextOverflow(e.target.value as OverflowPolicy)}
            className={selectClassName}
          >
            <option value="fallback">{t("teamsV2.onContextOverflowFallback")}</option>
            <option value="fail_fast">{t("teamsV2.onContextOverflowFailFast")}</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-neutral-400)]">
            {t("teamsV2.skillsLabel")}
          </label>
          <AgentSkillsPicker agentId={agent.id} />
        </div>
      </div>
```

- [ ] **Step 4: Verify manually**

There is no existing test file for this page (`apps/web/src/app/(app)/teams-v2/` has none today — only components are unit-tested in this codebase, matching `apps/web/src/app/(app)/skills/`, `apps/web/src/app/(app)/agents/`, which are also untested at the page level). Verify instead by running the dev server:

Run: `pnpm --filter @agentfactory/web dev` (or use the project's existing preview tooling)
Navigate to `/teams-v2`, select the "Agents" tab, pick an agent. Confirm:
- A "Skills" field appears below "On context overflow" showing every org skill as a checkbox.
- Checking an unassigned skill and unchecking an assigned one both take effect immediately (no Save click needed) and survive a page refresh.

Also run: `pnpm --filter @agentfactory/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(app\)/teams-v2/page.tsx apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): show the skills picker in the teams-v2 agent panel"
```

---

### Task 4: `SkillAgentsPicker` component

**Files:**
- Create: `apps/web/src/components/SkillAgentsPicker.tsx`
- Test: `apps/web/src/components/__tests__/SkillAgentsPicker.test.tsx`

**Interfaces:**
- Consumes: `MultiSelectCheckboxList`, `MultiSelectItem`, `Badge` from `@agentfactory/shared` (Task 1 and existing). `apiFetch<T>` from `@/lib/api-client`. Existing endpoints: `GET /api/agents` → `Agent[]`, `POST /api/agents/{agentId}/skills` body `{ skillId }` → `AgentSkill` (`{ agentId, skillId, skillVersionId, createdAt }`), `DELETE /api/agents/{agentId}/skills/{skillId}`.
- Produces: `export interface SkillAssignment { agentId: number; agentName: string; skillVersionId: number; version: number }` and `SkillAgentsPicker({ skillId: number; currentVersionNumber?: number; assignments: SkillAssignment[]; onAssignmentsChange: (next: SkillAssignment[]) => void })`, both exported from `@/components/SkillAgentsPicker`. Task 5 imports both.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/__tests__/SkillAgentsPicker.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { SkillAgentsPicker, type SkillAssignment } from "../SkillAgentsPicker";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const AGENTS: Agent[] = [
  { id: 1, orgId: 1, name: "Coding agent" } as Agent,
  { id: 2, orgId: 1, name: "Review agent" } as Agent,
];

const ASSIGNMENTS: SkillAssignment[] = [{ agentId: 1, agentName: "Coding agent", skillVersionId: 10, version: 2 }];

function mockApi(agents: Agent[] = AGENTS) {
  apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve({ agentId: 2, skillId: 9, skillVersionId: 11, createdAt: "2026-01-01T00:00:00.000Z" });
    }
    if (init?.method === "DELETE") return Promise.resolve(undefined);
    if (path === "/api/agents") return Promise.resolve(agents);
    return Promise.resolve(undefined);
  });
}

function renderPicker(assignments = ASSIGNMENTS) {
  const onAssignmentsChange = vi.fn();
  render(
    <I18nProvider>
      <SkillAgentsPicker
        skillId={9}
        currentVersionNumber={3}
        assignments={assignments}
        onAssignmentsChange={onAssignmentsChange}
      />
    </I18nProvider>,
  );
  return { onAssignmentsChange };
}

beforeEach(() => apiFetchMock.mockReset());

describe("SkillAgentsPicker", () => {
  it("shows every org agent, checked for the ones assigned to this skill", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Coding agent/ })).toBeChecked());
    expect(screen.getByRole("checkbox", { name: /Review agent/ })).not.toBeChecked();
  });

  it("shows the pinned version badge for an assigned agent", async () => {
    mockApi();
    renderPicker();
    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
  });

  it("assigns the skill to an agent when its checkbox is checked", async () => {
    mockApi();
    const { onAssignmentsChange } = renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Review agent/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /Review agent/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/2/skills", {
        method: "POST",
        body: JSON.stringify({ skillId: 9 }),
      }),
    );
    expect(onAssignmentsChange).toHaveBeenCalledWith([
      ...ASSIGNMENTS,
      { agentId: 2, agentName: "Review agent", skillVersionId: 11, version: 3 },
    ]);
  });

  it("unassigns the skill from an agent when its checkbox is unchecked", async () => {
    mockApi();
    const { onAssignmentsChange } = renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Coding agent/ })).toBeChecked());

    fireEvent.click(screen.getByRole("checkbox", { name: /Coding agent/ }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/1/skills/9", { method: "DELETE" }),
    );
    expect(onAssignmentsChange).toHaveBeenCalledWith([]);
  });

  it("shows an error when a toggle fails", async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.reject(new Error("boom"));
      if (path === "/api/agents") return Promise.resolve(AGENTS);
      return Promise.resolve(undefined);
    });
    renderPicker();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Review agent/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("checkbox", { name: /Review agent/ }));

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentfactory/web exec vitest run src/components/__tests__/SkillAgentsPicker.test.tsx`
Expected: FAIL — `Cannot find module '../SkillAgentsPicker'`

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/SkillAgentsPicker.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import type { Agent } from "@agentfactory/core";
import { Badge, MultiSelectCheckboxList, type MultiSelectItem } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

export interface SkillAssignment {
  agentId: number;
  agentName: string;
  skillVersionId: number;
  version: number;
}

export function SkillAgentsPicker({
  skillId,
  currentVersionNumber,
  assignments,
  onAssignmentsChange,
}: {
  skillId: number;
  currentVersionNumber?: number;
  assignments: SkillAssignment[];
  onAssignmentsChange: (next: SkillAssignment[]) => void;
}) {
  const { t } = useTranslation();
  const [allAgents, setAllAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAgentIds, setBusyAgentIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const agents = await apiFetch<Agent[]>("/api/agents");
      setAllAgents(agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    }
  }, [t]);

  useEffect(() => {
    // Initial fetch on mount; load() is async, so any setState it makes lands in a later
    // microtask, not synchronously here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function handleToggle(agentId: number) {
    setError(null);
    setBusyAgentIds((prev) => new Set(prev).add(agentId));
    try {
      const existing = assignments.find((a) => a.agentId === agentId);
      if (existing) {
        await apiFetch(`/api/agents/${agentId}/skills/${skillId}`, { method: "DELETE" });
        onAssignmentsChange(assignments.filter((a) => a.agentId !== agentId));
      } else {
        const pin = await apiFetch<{ skillVersionId: number }>(`/api/agents/${agentId}/skills`, {
          method: "POST",
          body: JSON.stringify({ skillId }),
        });
        const agentName = allAgents?.find((a) => a.id === agentId)?.name ?? "";
        onAssignmentsChange([
          ...assignments,
          { agentId, agentName, skillVersionId: pin.skillVersionId, version: currentVersionNumber ?? 0 },
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.loadError"));
    } finally {
      setBusyAgentIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }

  const items: MultiSelectItem[] = (allAgents ?? []).map((a) => {
    const assignment = assignments.find((x) => x.agentId === a.id);
    return {
      id: a.id,
      label: a.name,
      trailing: assignment ? <Badge>{`v${assignment.version}`}</Badge> : undefined,
    };
  });
  const selectedIds = new Set(assignments.map((a) => a.agentId));

  return (
    <div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      <MultiSelectCheckboxList
        items={items}
        selectedIds={selectedIds}
        onToggle={handleToggle}
        disabledIds={busyAgentIds}
        emptyMessage={t("skills.detail.noOrgAgents")}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentfactory/web exec vitest run src/components/__tests__/SkillAgentsPicker.test.tsx`
Expected: FAIL on this step is expected only if `skills.detail.noOrgAgents` is missing from `en.ts` — Task 5 adds it. Since this component only reads that key when `allAgents` is an empty array (not the case in any test above, `AGENTS` always has 2 entries), the tests should PASS (5 tests) even before Task 5 adds the key. Confirm all 5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/SkillAgentsPicker.tsx apps/web/src/components/__tests__/SkillAgentsPicker.test.tsx
git commit -m "feat(web): add SkillAgentsPicker for assigning a skill to multiple agents"
```

---

### Task 5: `DeleteSkillButton` and skill detail page wiring

**Files:**
- Create: `apps/web/src/components/DeleteSkillButton.tsx`
- Modify: `apps/web/src/app/(app)/skills/[skillId]/page.tsx`
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts` (`skills.detail` additions/removal)
- Test: `apps/web/src/components/__tests__/DeleteSkillButton.test.tsx`

**Interfaces:**
- Consumes: `Button`, `TooltipBubble` from `@agentfactory/shared`. `ConfirmDialog` from `@/components/ConfirmDialog` (existing, props `{ title, message, confirmLabel, cancelLabel, onConfirm, onCancel }`). `apiFetch<T>` from `@/lib/api-client`. `TrashIcon` from `@/lib/icons`. Existing endpoint: `DELETE /api/skills/{skillId}` (204 on success, or throws with the server's `{ error }` message on failure — `apiFetch` already turns that into `Error(message)`).
- Produces: `DeleteSkillButton({ skillId: number; skillName: string; assignedAgentNames: string[]; onDeleted: () => void; onError: (message: string) => void })`, exported from `@/components/DeleteSkillButton`. Consumed only by the skill detail page in this task.
- Also consumes (from Task 4): `SkillAgentsPicker`, `type SkillAssignment` from `@/components/SkillAgentsPicker`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/__tests__/DeleteSkillButton.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { DeleteSkillButton } from "../DeleteSkillButton";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function renderButton(overrides: { assignedAgentNames?: string[] } = {}) {
  const onDeleted = vi.fn();
  const onError = vi.fn();
  render(
    <I18nProvider>
      <DeleteSkillButton
        skillId={9}
        skillName="Conventional commits"
        assignedAgentNames={overrides.assignedAgentNames ?? []}
        onDeleted={onDeleted}
        onError={onError}
      />
    </I18nProvider>,
  );
  return { onDeleted, onError };
}

beforeEach(() => apiFetchMock.mockReset());

describe("DeleteSkillButton", () => {
  it("is enabled when no agents are assigned", () => {
    renderButton();
    expect(screen.getByRole("button", { name: /Delete/ })).not.toBeDisabled();
  });

  it("is disabled and shows a tooltip listing the assigned agents when any are assigned", () => {
    renderButton({ assignedAgentNames: ["Coding agent", "Review agent"] });
    expect(screen.getByRole("button", { name: /Delete/ })).toBeDisabled();
    expect(
      screen.getByText("Assigned to Coding agent, Review agent. Unassign from these agents before deleting."),
    ).toBeInTheDocument();
  });

  it("opens a confirm dialog when clicked while enabled", () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(screen.getByText("Delete 'Conventional commits'?")).toBeInTheDocument();
  });

  it("deletes the skill and calls onDeleted when confirmed", async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { onDeleted } = renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    // Two "Delete" buttons exist once the dialog is open: the (now-hidden-behind-the-modal)
    // trigger, and the dialog's own confirm button, which renders second in DOM order.
    const [, confirmButton] = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/skills/9", { method: "DELETE" }));
    expect(onDeleted).toHaveBeenCalled();
  });

  it("calls onError and closes the dialog when deletion fails", async () => {
    apiFetchMock.mockRejectedValue(new Error("Skill is assigned to an agent; unassign it first"));
    const { onError } = renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    const [, confirmButton] = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Skill is assigned to an agent; unassign it first"));
    expect(screen.queryByText("Delete 'Conventional commits'?")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentfactory/web exec vitest run src/components/__tests__/DeleteSkillButton.test.tsx`
Expected: FAIL — `Cannot find module '../DeleteSkillButton'`

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/DeleteSkillButton.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button, TooltipBubble } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TrashIcon } from "@/lib/icons";

export function DeleteSkillButton({
  skillId,
  skillName,
  assignedAgentNames,
  onDeleted,
  onError,
}: {
  skillId: number;
  skillName: string;
  assignedAgentNames: string[];
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const blocked = assignedAgentNames.length > 0;

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch<void>(`/api/skills/${skillId}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("common.loadError"));
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="group/tooltip relative">
      <Button variant="secondary" onClick={() => setConfirming(true)} disabled={blocked}>
        <TrashIcon size={14} />
        {t("skills.detail.deleteButton")}
      </Button>
      {blocked && (
        <TooltipBubble
          label={t("skills.detail.deleteBlockedTooltip", { agents: assignedAgentNames.join(", ") })}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={t("skills.detail.confirmDeleteTitle", { name: skillName })}
          message={t("skills.detail.confirmDeleteMessage")}
          confirmLabel={deleting ? t("skills.detail.deleting") : t("skills.detail.confirmDeleteButton")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setConfirming(false)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
```

In `apps/web/src/lib/i18n/dictionaries/en.ts`, find the `skills.detail` block:

```ts
    detail: {
      noPublishedVersion: "Not published yet — this skill only has a draft.",
      versionHistory: "Version history",
      draftLabel: "Draft",
      currentBadge: "Current",
      publish: "Publish",
      publishing: "Publishing…",
      saveDraft: "Save draft",
      savingDraft: "Saving…",
      assignedAgents: "Assigned agents",
      noAssignedAgents: "No agents have this skill assigned yet.",
    },
```

Replace it with:

```ts
    detail: {
      noPublishedVersion: "Not published yet — this skill only has a draft.",
      versionHistory: "Version history",
      draftLabel: "Draft",
      currentBadge: "Current",
      publish: "Publish",
      publishing: "Publishing…",
      saveDraft: "Save draft",
      savingDraft: "Saving…",
      assignedAgents: "Assigned agents",
      deleteButton: "Delete",
      confirmDeleteTitle: "Delete '{name}'?",
      confirmDeleteMessage: "This will permanently remove the skill.",
      confirmDeleteButton: "Delete",
      deleting: "Deleting…",
      deleteBlockedTooltip: "Assigned to {agents}. Unassign from these agents before deleting.",
      noOrgAgents: "No agents exist yet.",
    },
```

Now wire the skill detail page. In `apps/web/src/app/(app)/skills/[skillId]/page.tsx`, replace the full import block and the `SkillAssignment` interface (everything from the top of the file through the `interface SkillAssignment { ... }` block) with:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { Skill, SkillVersion } from "@agentfactory/core";
import { Badge, Breadcrumb, Button, Card, TextInput, Textarea } from "@agentfactory/shared";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";
import { relativeTime } from "@/lib/relative-time";
import { ArrowLeftIcon, EditIcon } from "@/lib/icons";
import { DeleteSkillButton } from "@/components/DeleteSkillButton";
import { SkillAgentsPicker, type SkillAssignment } from "@/components/SkillAgentsPicker";
```

Add a `useRouter()` call alongside the existing `useParams()` and `useTranslation()` calls near the top of the component:

```tsx
export default function SkillDetailPage() {
  const { skillId } = useParams<{ skillId: string }>();
  const { t } = useTranslation();
  const router = useRouter();
```

Find the header actions block:

```tsx
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={openEditor} disabled={startingDraft || editing}>
            <EditIcon size={14} />
            {startingDraft ? t("common.loading") : t("common.edit")}
          </Button>
          {draftVersion && !editing && (
            <Button onClick={publish} disabled={publishing}>
              {publishing ? t("skills.detail.publishing") : t("skills.detail.publish")}
            </Button>
          )}
        </div>
```

Replace it with:

```tsx
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={openEditor} disabled={startingDraft || editing}>
            <EditIcon size={14} />
            {startingDraft ? t("common.loading") : t("common.edit")}
          </Button>
          {draftVersion && !editing && (
            <Button onClick={publish} disabled={publishing}>
              {publishing ? t("skills.detail.publishing") : t("skills.detail.publish")}
            </Button>
          )}
          <DeleteSkillButton
            skillId={skill.id}
            skillName={skill.name}
            assignedAgentNames={assignments.map((a) => a.agentName)}
            onDeleted={() => router.push("/skills")}
            onError={setError}
          />
        </div>
```

Find the "Assigned agents" block:

```tsx
      <div className="px-10 pt-8">
        <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t("skills.detail.assignedAgents")}</h2>
        {assignments.length === 0 ? (
          <Card className="px-5 py-10 text-center text-sm text-[var(--color-neutral-500)]">
            {t("skills.detail.noAssignedAgents")}
          </Card>
        ) : (
          <div className="space-y-2">
            {assignments.map((a) => (
              <Card key={a.agentId} className="flex items-center justify-between px-5 py-4">
                <Link href={`/agents/${a.agentId}`} className="text-sm font-medium text-[var(--color-text)] hover:underline">
                  {a.agentName}
                </Link>
                <Badge>{`v${a.version}`}</Badge>
              </Card>
            ))}
          </div>
        )}
      </div>
```

Replace it with:

```tsx
      <div className="px-10 pt-8">
        <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{t("skills.detail.assignedAgents")}</h2>
        <SkillAgentsPicker
          skillId={skill.id}
          currentVersionNumber={currentVersion?.version}
          assignments={assignments}
          onAssignmentsChange={setAssignments}
        />
      </div>
```

Note this file no longer uses `next/link`'s `Link` (only the removed block used it) — the plan's replacement import block above already omits it. `Badge` is still used elsewhere in this file (the version history table's "Current" badge), so its import stays.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentfactory/web exec vitest run src/components/__tests__/DeleteSkillButton.test.tsx`
Expected: PASS (5 tests)

Run: `pnpm --filter @agentfactory/web exec vitest run src/components/__tests__/SkillAgentsPicker.test.tsx`
Expected: still PASS (5 tests) — confirms adding `skills.detail.noOrgAgents` didn't break Task 4's tests.

Run: `pnpm --filter @agentfactory/web exec tsc --noEmit`
Expected: no errors (confirms `Link` and `SkillAssignment`'s old local declaration are fully gone with no leftover references, and the page's use of `Badge`, `currentVersion`, and `assignments` still type-checks).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/DeleteSkillButton.tsx apps/web/src/components/__tests__/DeleteSkillButton.test.tsx apps/web/src/app/\(app\)/skills/\[skillId\]/page.tsx apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): let a user delete a skill and multi-select its assigned agents from the skill page"
```

---

## Final verification

- [ ] Run the full unit suite: `pnpm test:unit`
Expected: all tests pass, including the new `MultiSelectCheckboxList`, `AgentSkillsPicker`, `SkillAgentsPicker`, and `DeleteSkillButton` suites.
- [ ] Run `pnpm typecheck` from the repo root.
Expected: no errors across `packages/shared`, `packages/core`, and `apps/web`.
- [ ] Run `pnpm lint` from the repo root.
Expected: no errors.
- [ ] Manual smoke test with the dev server (`pnpm dev`): on `/skills/[id]`, check/uncheck an agent, confirm the Delete button disables/enables and the tooltip lists the right agent names, confirm delete navigates back to `/skills`. On `/teams-v2`, confirm the Skills field in the agent panel matches what `/skills/[id]` shows for that same agent.
