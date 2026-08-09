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

export interface ErrorEvent extends RunEventBase {
  type: "error";
  message: string;
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
  | ArtifactEvent
  | UsageEvent
  | ErrorEvent
  | DoneEvent;
