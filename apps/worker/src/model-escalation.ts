import type { OverflowPolicy } from "@agentfactory/core";
import { nextEscalationTier } from "@agentfactory/core";

// Given the model a turn just overflowed on and the agent's overflow policy, returns the model
// id to retry with, or undefined if escalation should stop — either the policy is fail_fast, or
// the ladder's exhausted (already on claude-opus-5, or on claude-fable-5 which isn't on it at all).
export function resolveEscalation(currentModelId: string, policy: OverflowPolicy): string | undefined {
  if (policy === "fail_fast") return undefined;
  return nextEscalationTier(currentModelId);
}
