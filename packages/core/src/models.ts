import type { AgentRole, ModelSpec, OverflowPolicy } from "./domain";

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

// Explicit list, not derived from MODEL_CATALOG order — keeps Fable's exclusion a deliberate
// fact in the data rather than an accident of catalog ordering. Used by the worker's context-
// overflow escalation (apps/worker/src/model-escalation.ts) to find the next larger-context
// model in the same family.
const ESCALATION_LADDER = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"] as const;

export function nextEscalationTier(modelId: string): string | undefined {
  const index = ESCALATION_LADDER.indexOf(modelId as (typeof ESCALATION_LADDER)[number]);
  if (index === -1 || index === ESCALATION_LADDER.length - 1) return undefined;
  return ESCALATION_LADDER[index + 1];
}

export function isValidModelId(id: string): boolean {
  return MODEL_CATALOG.some((entry) => entry.id === id);
}

export function isValidOverflowPolicy(value: string): value is OverflowPolicy {
  return value === "fallback" || value === "fail_fast";
}

export function isValidAgentRole(value: unknown): value is AgentRole {
  return value === "developer" || value === "reviewer";
}

export function buildModelSpec(id: string = DEFAULT_MODEL_ID): ModelSpec {
  return { family: "anthropic", id, maxTokens: 8192 };
}
