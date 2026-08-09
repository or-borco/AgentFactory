import type { ModelSpec } from "./domain";

export interface ModelCatalogEntry {
  id: string;
  label: string;
}

// The selectable models for an agent's default and a task's override. Keep in sync with the
// worker's ClaudeCodeRuntime — these ids are passed straight through as the Anthropic API model
// string (see apps/worker/src/claude-runtime.ts).
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-fable-5", label: "Claude Fable 5" },
];

export const DEFAULT_MODEL_ID = "claude-sonnet-5";

export function isValidModelId(id: string): boolean {
  return MODEL_CATALOG.some((entry) => entry.id === id);
}

export function buildModelSpec(id: string = DEFAULT_MODEL_ID): ModelSpec {
  return { family: "anthropic", id, maxTokens: 8192 };
}
