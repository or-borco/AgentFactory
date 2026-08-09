# Task model selector — design spec

**Date:** 2026-08-05
**Status:** approved

## Problem

When creating a task, users have no way to specify which Claude model the task will run with. Tasks inherit the assigned agent's configured model implicitly, with no visibility or control at task creation time.

## Goal

Add a model selector to the create task form that:
1. Shows the assigned agent's configured model as the default.
2. Lets the user override it for just this task.

## Scope

- UI only (M0 mock phase). No real agent execution is wired up.
- Model list is hardcoded to the four known Claude models. No API fetch needed.

## Hardcoded model list

| Display name | Model ID |
|---|---|
| Claude Haiku 4.5 | `claude-haiku-4-5` |
| Claude Sonnet 5 | `claude-sonnet-5` |
| Claude Opus 5 | `claude-opus-5` |
| Claude Fable 5 | `claude-fable-5` |

## Data model changes

### `packages/core/src/domain.ts`

Add `model?: ModelSpec` to `Task`. Optional — absent means the task inherits the agent's model. The field stores the override value when the user picks a different model than the agent's default.

```ts
export interface Task {
  // ... existing fields ...
  model?: ModelSpec;  // per-task model override; absent = use agent's model
}
```

### `apps/web/src/lib/mock/context.tsx`

Add `model?: ModelSpec` to `NewTaskInput` and thread it through `createTask` so it is persisted on the task object.

```ts
interface NewTaskInput {
  // ... existing fields ...
  model?: ModelSpec;
}
```

## UI changes

### Placement

A new `Model` field is added to `apps/web/src/app/(app)/tasks/new/page.tsx`, between the Assignee field and the Area/Codebase row. This placement is intentional: model choice is conceptually tied to the agent selection above it.

### Component

A native `<select>` using the existing `selectStyle()` helper, consistent with Assignee and Codebase selects already in the form.

A small helper note below the select (same `<p>` pattern used for "One criterion per line") explains the current state:
- Agent selected, model unchanged: "Defaulting to [Agent]'s configured model. Change to override for this task."
- Agent selected, model changed: "Overriding [Agent]'s default model for this task."
- No agent selected: "No agent selected — pick a model or assign an agent first."

### Behavior

- On mount: model dropdown defaults to `claude-sonnet-5`.
- When assignee changes: model dropdown auto-sets to that agent's `model.id`. If the agent's model ID doesn't match any entry in the hardcoded list, fall back to `claude-sonnet-5`.
- User can freely change the dropdown at any time after agent selection.
- On submit: the selected `ModelSpec` is included in `NewTaskInput.model` if it differs from the agent's default, or always (simpler implementation — the runtime will treat it as the override).

### State

Two new state variables in `NewTaskPage`:

```ts
const [modelId, setModelId] = useState<string>("claude-sonnet-5");
const [modelOverriddenByUser, setModelOverriddenByUser] = useState(false);
```

`modelOverriddenByUser` tracks whether the user manually changed the model after an agent was selected, to drive the helper note copy.

## i18n

Add to `tasks.create` in `apps/web/src/lib/i18n/dictionaries/en.ts`:

```ts
modelLabel: "Model",
modelNoteDefault: "Defaulting to {agent}'s configured model. Change to override for this task.",
modelNoteOverride: "Overriding {agent}'s default model for this task.",
modelNoteNoAgent: "No agent selected — pick a model or assign an agent first.",
```

Note: the existing `t()` helper does not support interpolation, so these strings may be assembled in the component directly using the agent name — only the static portions go through `t()`.

## Mock API / store changes

The `createTask` route handler and mock store already accept arbitrary task fields through `NewTaskInput`. Threading `model` requires:
1. Adding `model?: ModelSpec` to `NewTaskInput` (context.tsx).
2. Passing `model` in the `createTask` call in `new/page.tsx`.
3. No changes needed to the API route or mock store beyond accepting the field — the store spreads the input onto the task object.

## Out of scope

- Showing the model on the task detail page (follow-up).
- Model pricing or capability hints in the dropdown (follow-up).
- Dynamic model list from an API (future, when real backend exists).
