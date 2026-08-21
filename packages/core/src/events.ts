import type { ID, ISODateTime } from "./domain";

interface RunEventBase {
  id: ID;
  runId: ID;
  seq: number;
  createdAt: ISODateTime;
}

export interface TextDeltaEvent extends RunEventBase {
  type: "text_delta";
  text: string;
}

export interface ThinkingDeltaEvent extends RunEventBase {
  type: "thinking_delta";
  text: string;
}

export interface ToolCallEvent extends RunEventBase {
  type: "tool_call";
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends RunEventBase {
  type: "tool_result";
  tool: string;
  output: unknown;
  isError: boolean;
}

export interface PolicyDecisionEvent extends RunEventBase {
  type: "policy_decision";
  tool: string;
  decision: "allow" | "deny";
  ruleMatched: string;
}

export interface ModelEscalatedEvent extends RunEventBase {
  type: "model_escalated";
  fromModel: string;
  toModel: string;
  reason: "context_overflow";
}

export interface ArtifactEvent extends RunEventBase {
  type: "artifact";
  artifactType: "pr" | "diff" | "file" | "report";
  label: string;
  url?: string;
}

export interface UsageEvent extends RunEventBase {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// Classifies a run failure beyond its free-text message, so callers (e.g. the web app's chat
// UI) can show a specific, safe message instead of always falling back to a generic one.
// Add new codes here as more failure classes get classified — an unknown/absent code just means
// "show the generic error", never a broken build.
export type ErrorCode = "insufficient_credit";

export interface ErrorEvent extends RunEventBase {
  type: "error";
  message: string;
  code?: ErrorCode;
}

export interface ContextIncludedEvent extends RunEventBase {
  type: "context_included";
  included: boolean;
  preview: string;
}

export interface DoneEvent extends RunEventBase {
  type: "done";
  reason: "completed" | "cancelled" | "budget_exceeded" | "error";
}

export type RunEvent =
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | PolicyDecisionEvent
  | ModelEscalatedEvent
  | ArtifactEvent
  | UsageEvent
  | ErrorEvent
  | ContextIncludedEvent
  | DoneEvent;
