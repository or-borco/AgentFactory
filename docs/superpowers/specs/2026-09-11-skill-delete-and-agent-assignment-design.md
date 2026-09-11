# Skill deletion and multi-select agent assignment - design spec

**Date:** 2026-09-11
**Status:** approved
**Issue:** none (ad hoc request)

## Problem

The Skills feature ([2026-09-10-skills-feature-design.md](2026-09-10-skills-feature-design.md)) shipped a full backend for assigning a skill's current published version to an agent, upgrading that pin, unassigning it, and deleting a skill, but the frontend only exposes part of it:

- There is no way to delete a skill anywhere in the UI, even though `DELETE /api/skills/[skillId]` (`apps/web/src/app/api/skills/[skillId]/route.ts:15-26`) already exists and already refuses (409) when any agent is still assigned.
- `/agents/[agentId]`'s `AgentSkillsSection` (`apps/web/src/components/AgentSkillsSection.tsx`) lets you assign skills to that one agent, but only one at a time via a single dropdown, with a separate remove button per row.
- The teams-v2 agent editing panel (`apps/web/src/app/(app)/teams-v2/page.tsx`'s `AgentDetailPanel`, the screenshot the user is looking at) has no skills UI at all, even though the underlying API (`GET/POST/DELETE /api/agents/[agentId]/skills[/skillId]`) is agent-agnostic and works from any surface.
- The skill detail page (`apps/web/src/app/(app)/skills/[skillId]/page.tsx:204-222`) shows assigned agents, but read-only, by an explicit prior decision recorded in `packages/db/src/repositories/agent-skills.ts:72-74`: *"Reverse lookup for the skill detail page ... read-only there; unassign/upgrade actions live only on the agent page ... so the two pages never race to mutate the same pin."*

## Goal

A user can:

1. Delete a skill, blocked (not just rejected) while it is still assigned to any agent.
2. From the agent editing panel inside a team's page, multi-select which skills that agent has, checking or unchecking freely.
3. From a skill's own detail page, multi-select which agents have that skill, checking or unchecking freely.

Both multi-select surfaces mutate the same underlying `agent_skills` pin data and take effect immediately per checkbox, with no separate Save step.

## Ground truth this design relies on

- **Assignment, unassignment, and version-upgrade already work end to end.** `packages/db/src/repositories/agent-skills.ts` exports `listAgentSkills`, `assignSkillToAgent` (always pins `skill.currentVersionId`), `updateAgentSkillVersion`, `unassignSkillFromAgent`, and `listSkillAssignments` (the skill-to-agents reverse lookup). All are already wired into routes under `apps/web/src/app/api/agents/[agentId]/skills/**` and `apps/web/src/app/api/skills/[skillId]/assignments/route.ts`. This design adds no new backend code.
- **`agent_skills` is keyed `(agent_id, skill_id)`** (`packages/db/src/schema.ts`, per the 2026-09-10 design), and `assignSkillToAgent` upserts on that key (`onConflictDoUpdate`). A checkbox toggled from two different open tabs at once resolves as last-write-wins on that same row, not a data-corrupting race. This is why overriding the skill-page-is-read-only decision above is safe.
- **`deleteSkillForOrg`** (`packages/db/src/repositories/skills.ts:99-104`) already returns `false` (routed to a 409) when any `agent_skills` row references the skill. This design's UI-level disable is a courtesy that keeps that 409 unreachable in normal use; the API-level guard stays as the backstop.
- **No multi-select or checkbox-list component exists anywhere in the repo today** (`packages/shared` or `apps/web`). The closest precedents are single-`<select>` pickers: `apps/web/src/components/AssigneeSelect.tsx` and the inline `<select>`s in `AgentSkillsSection.tsx` and `teams-v2/page.tsx`.
- **`packages/shared`** exports `PageHeader, Breadcrumb, Button, Badge, Card, CardLink, TextInput, Textarea, TooltipBubble, Truncate, EmptyState, Tabs, UsageMeter` - `TooltipBubble` already exists and is reused for the disabled-delete explanation rather than building a new tooltip primitive.
- **`ConfirmDialog`** (`apps/web/src/components/ConfirmDialog.tsx`, wrapping `Modal.tsx`) is the established delete-confirmation pattern, used by task delete and connection delete. This design reuses it as-is for skill delete.
- **Component tests exist for comparable single-`<select>` components** (`apps/web/src/components/__tests__/AssigneeSelect.test.tsx`), establishing the pattern the new components' tests follow.

## Scope

- `packages/shared/src/` - new `MultiSelectCheckboxList` primitive, exported alongside the other shared components.
- `apps/web/src/components/AgentSkillsSection.tsx` - internals replaced to use the new picker instead of its current single-`<select>` + remove-button list; public usage from `agents/[agentId]/page.tsx` is unchanged.
- New `apps/web/src/components/AgentSkillsPicker.tsx` - the agent-owns-skills fetch/toggle logic, used both by `AgentSkillsSection.tsx` and by `teams-v2/page.tsx`'s `AgentDetailPanel`.
- New `apps/web/src/components/SkillAgentsPicker.tsx` - the skill-owns-agents fetch/toggle logic, used by the skill detail page.
- `apps/web/src/app/(app)/teams-v2/page.tsx` - `AgentDetailPanel` gains a "Skills" block using `AgentSkillsPicker`.
- `apps/web/src/app/(app)/skills/[skillId]/page.tsx` - "Assigned agents" section becomes interactive (`SkillAgentsPicker`); header gains a disabled-when-assigned "Delete" button with `TooltipBubble` and `ConfirmDialog`.
- `apps/web/src/lib/i18n/dictionaries/en.ts` - new strings for the delete action and the two picker surfaces.
- Component tests for `MultiSelectCheckboxList`, `AgentSkillsPicker`, `SkillAgentsPicker`, and the skill detail page's delete flow.

## Out of scope

- No new API routes. Every mutation this design's UI performs already has an endpoint.
- No version-upgrade control on the skill-page picker. Upgrading a pinned version stays an agent-page-only action, unchanged from today.
- No bulk multi-agent-at-once API call. Each checkbox toggle is its own `POST`/`DELETE` request against the existing single-pair endpoints; there is no new batch endpoint.
- No change to how a skill's own draft/publish/version-history editing works.
- No change to `/agents/[agentId]` page layout beyond what's needed to swap in the new picker internals.

## Design decisions

- **One generic `MultiSelectCheckboxList` in `packages/shared`, two thin data-owning wrappers in `apps/web`.** The shared component is pure presentation: `items: {id, label, sublabel?, trailing?}[]`, `selectedIds: Set<number>`, `onToggle(id)`, `disabledIds?: Set<number>` (rows mid-request), `emptyMessage?`. It knows nothing about skills or agents. `AgentSkillsPicker` and `SkillAgentsPicker` each own their own `apiFetch` calls and feed the shared list. This mirrors the existing split between `packages/shared` (no business logic) and `apps/web` (owns data).
- **Instant-apply, no Save button.** Each checkbox toggle immediately calls the relevant `POST`/`DELETE` endpoint, matching how the existing single-select skill picker already behaves. A toggled row is added to `disabledIds` until its request resolves, then removed (whether it succeeded or failed); a failed toggle reverts the checkbox and shows the existing inline error pattern (`err.message`) already used on both the skill detail page and `AgentSkillsSection.tsx`.
- **`AgentSkillsSection.tsx` is refactored, not duplicated.** Its current single-`<select>` + remove-button internals are replaced by `AgentSkillsPicker`, which is also embedded in `teams-v2`'s `AgentDetailPanel`. One component owns "which skills does this agent have," used from both places it needs to appear. The per-row version-upgrade `<select>` that exists today is preserved in `AgentSkillsPicker`'s `trailing` slot for assigned rows, so that capability isn't lost in the refactor.
- **`SkillAgentsPicker` overrides the prior "skill page is read-only" decision.** The `agent-skills.ts` comment's stated reason (avoiding two pages racing to mutate the same pin) is addressed by the upsert-on-`(agent_id, skill_id)` behavior already in place, not by keeping the page read-only. `SkillAgentsPicker` has no version-upgrade control since that capability intentionally stays agent-page-only.
- **Delete is disabled, not merely rejected, while the skill is assigned.** The skill detail page already fetches `assignments` (`skills.detail`'s existing `load()`). The "Delete" button is disabled whenever `assignments.length > 0`, wrapped in `TooltipBubble` listing the assigned agents' names (e.g. "Assigned to Coding agent, Review agent - unassign from these agents before deleting"). Once `SkillAgentsPicker` unassigns an agent and local `assignments` state drops to zero (no refetch needed - the picker's toggle already updates the page's assignment list), the button enables itself. The `ConfirmDialog` confirmation only ever fires when the button is clickable, so the API's 409 path becomes unreachable in normal use; it stays in place as a backstop for a stale-state edge case (e.g. two tabs).
- **The skill detail page's `assignments` state and `SkillAgentsPicker`'s own state are the same list, not two independent fetches.** `SkillAgentsPicker` receives `assignments` and an `onAssignmentsChange` callback as props rather than fetching independently, so the page's disabled-delete logic and the picker's checked state can never disagree without an extra round trip.

## Mechanism

### `MultiSelectCheckboxList` (packages/shared)

```ts
interface MultiSelectItem {
  id: number;
  label: string;
  sublabel?: string;
  trailing?: React.ReactNode;
}

interface MultiSelectCheckboxListProps {
  items: MultiSelectItem[];
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  disabledIds?: Set<number>;
  emptyMessage?: string;
}
```

Renders a bordered list (visually consistent with the existing `Card`-based lists on the skill/agent pages): one row per item, a checkbox bound to `selectedIds.has(item.id)`, the label, optional sublabel, and the `trailing` node right-aligned. `emptyMessage` renders in place of the list when `items` is empty.

### `AgentSkillsPicker` (apps/web/src/components/AgentSkillsPicker.tsx)

Props: `{ agentId: number }`. On mount, fetches `GET /api/agents/{agentId}/skills` (assigned) and `GET /api/skills` (all org skills) in parallel, same as today's `AgentSkillsSection`. Builds `items` from the union of both lists; `selectedIds` from the assigned set. A skill with no `currentVersionId` (draft only, never published) is included with its `sublabel` set to the existing `skills.draftOnlyBadge` text and pre-added to `disabledIds`, matching today's dropdown which already excludes unpublishable skills from being chosen. `trailing` for an assigned row reproduces today's version `<select>` (`PATCH /api/agents/{agentId}/skills/{skillId}`). `onToggle(skillId)`:

- Not currently selected -> `POST /api/agents/{agentId}/skills` with `{ skillId }`.
- Currently selected -> `DELETE /api/agents/{agentId}/skills/{skillId}`.

`AgentSkillsSection.tsx` becomes a thin wrapper: page heading + padding + `<AgentSkillsPicker agentId={agentId} />`. `teams-v2/page.tsx`'s `AgentDetailPanel` embeds the same `<AgentSkillsPicker agentId={agent.id} />` inside its existing scrollable fields block, under a "Skills" label matching the style of its other field labels.

### `SkillAgentsPicker` (apps/web/src/components/SkillAgentsPicker.tsx)

Props: `{ skillId: number; assignments: SkillAssignment[]; onAssignmentsChange: (next: SkillAssignment[]) => void }`. On mount, fetches `GET /api/agents` (all org agents) - `assignments` is passed down from the skill detail page's existing `load()`, not refetched here. `items` from the org agents list; `selectedIds` from `assignments.map(a => a.agentId)`. No `trailing` control. `onToggle(agentId)`:

- Not currently selected -> `POST /api/agents/{agentId}/skills` with `{ skillId }`, then calls `onAssignmentsChange` with the new assignment appended (using the response's `skillVersionId` and the agent's name from the already-fetched agent list).
- Currently selected -> `DELETE /api/agents/{agentId}/skills/{skillId}`, then calls `onAssignmentsChange` filtering that agent out.

### Skill detail page changes

- The existing read-only "Assigned agents" block (`skills/[skillId]/page.tsx:204-222`) is replaced by `<SkillAgentsPicker skillId={skill.id} assignments={assignments} onAssignmentsChange={setAssignments} />`.
- Header action row gains a "Delete" button next to Edit/Publish: `disabled={assignments.length > 0}`, wrapped in `<TooltipBubble>` whose content lists `assignments.map(a => a.agentName).join(", ")` when disabled.
- Clicking (when enabled) opens `<ConfirmDialog>`; `onConfirm` calls `DELETE /api/skills/{skillId}`, then `router.push("/skills")` on success. A caught error (the 409 backstop, or any other failure) sets the page's existing `error` state and closes the dialog.

## Testing

- **`MultiSelectCheckboxList.test.tsx`** (new, `packages/shared`): renders items with correct checked state from `selectedIds`; clicking an unchecked row calls `onToggle` with that id; a row in `disabledIds` renders disabled and does not call `onToggle`; `emptyMessage` renders when `items` is empty.
- **`AgentSkillsPicker.test.tsx`** (new, `apps/web`, following `AssigneeSelect.test.tsx`'s pattern with mocked `apiFetch`): checking an unassigned skill calls `POST .../skills`; unchecking an assigned skill calls `DELETE .../skills/{id}`; a failed toggle reverts the checkbox and shows an error.
- **`SkillAgentsPicker.test.tsx`** (new, same pattern): checking an unassigned agent calls `POST /api/agents/{agentId}/skills` with this skill's id; unchecking calls the matching `DELETE`; `onAssignmentsChange` is called with the updated list in both directions.
- **Skill detail page delete flow** (extends or adds to any existing page-level test, or a new one if none exists yet): Delete button is disabled with `assignments.length > 0` and shows the agent names in its tooltip; enabled once `assignments` is empty; confirming calls `DELETE /api/skills/{skillId}` and navigates to `/skills`.
- No new backend tests - `deleteSkillForOrg`'s assigned-skill guard and the assign/unassign/upgrade repository functions are already covered in `packages/db/src/__tests__/repositories/`.

## PR sequence

| # | PR | Contents | Demoable |
|---|---|---|---|
| 1 | **Shared multi-select primitive** | `MultiSelectCheckboxList` in `packages/shared` + its test | No (no consumer yet) |
| 2 | **Agent-side picker** | `AgentSkillsPicker`, refactored `AgentSkillsSection.tsx`, `teams-v2` `AgentDetailPanel` Skills block, tests | Yes - multi-select skills from both agent surfaces |
| 3 | **Skill-side picker + delete** | `SkillAgentsPicker`, skill detail page wiring, disabled-delete + tooltip + `ConfirmDialog`, tests | Yes - multi-select agents from the skill page, delete a skill |

PR 2 and 3 could also ship as one PR given their combined size is still small (no schema, no new routes); split here mainly so the agent-side refactor can be reviewed independently of the skill-page behavior change (overriding the prior read-only decision).

## Risks

- **Refactoring `AgentSkillsSection.tsx`'s internals touches a page (`/agents/[agentId]`) the user didn't explicitly mention.** Accepted per explicit user confirmation - done for consistency rather than leaving two different UI patterns (dropdown-add vs. checkbox-list) for the same underlying data.
- **`SkillAgentsPicker` fetches all org agents (`GET /api/agents`) unfiltered.** Fine at current org sizes; if an org's agent count grows large enough to make a full checkbox list unwieldy, this would need pagination or search - not addressed here.
