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
  artifactType: "pr" | "diff" | "file" | "report" | "review";
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

// Emitted only for the two outcomes worth a permanent record: a successful sync (the checkout
// changed under the agent) or a conflict (which recurs on every future run until someone
// resolves it, unlike a merely dirty tree, which self-heals next run and gets no event at all).
export interface RepoSyncEvent extends RunEventBase {
  type: "repo_sync";
  status: "synced" | "skipped_conflict";
  commitsMerged?: number;
  conflictingFiles?: string[];
}

export interface DependencyInstallStep {
  label: string;
  command: string;
  status: "ok" | "failed" | "timed_out" | "missing_tool" | "up_to_date";
  exitCode?: number;
  durationMs: number;
  outputTail?: string;
}

export interface DependencyInstallEvent extends RunEventBase {
  type: "dependency_install";
  status: "up_to_date" | "installed" | "failed";
  source: "detected" | "none";
  durationMs: number;
  reused: boolean;
  steps: DependencyInstallStep[];
}

// Deliberately no `content` field (see AgentMemoryEntry's comment in domain.ts). `events.data` is
// plaintext (unlike agent_memory_entries.ciphertext), so echoing the lesson text here would leak
// the exact sensitive content the encrypted column exists to protect, right back out through the
// run transcript UI. `reinforced` is the only signal the transcript shows: whether this write
// created a new lesson or reinforced an existing one.
export interface MemoryWriteEvent extends RunEventBase {
  type: "memory_write";
  reinforced: boolean;
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
  | RepoSyncEvent
  | DependencyInstallEvent
  | MemoryWriteEvent
  | DoneEvent;
