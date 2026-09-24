import type { ModelSpec, RuntimeKind } from "@agentfactory/core";
import type { SandboxProvider } from "../sandbox/types";

export interface AgentTurnResult {
  text: string;
  providerSessionRef: string;
  structuredOutput?: unknown;
}

// Named RuntimeEvent, not RunEvent, to avoid colliding with @agentfactory/core's RunEvent (the
// persisted event row, with id/runId/seq/createdAt) — this is the raw shape a runtime emits
// before worker.ts wraps it into a stored event via createEvent().
export interface ThinkingDeltaRuntimeEvent {
  type: "thinking_delta";
  text: string;
  tool?: string;
  description?: string;
  command?: string;
  filePath?: string;
}

// Emitted by the sandbox's `remember` SDK tool (run-turn-claude.ts) the moment a lesson is
// dictated mid-turn. Worker.ts's onEvent handler special-cases this type to call
// writeMemoryEntry and persist a content-free MemoryWriteEvent, rather than the generic
// `createEvent(runId, seq++, event.type, { ...event })` every other runtime event goes through
// (which would otherwise leak the plaintext lesson into the unencrypted events.data column).
export interface MemoryWriteRuntimeEvent {
  type: "memory_write";
  content: string;
}

export interface ToolResultRuntimeEvent {
  type: "tool_result";
  toolUseId: string;
  tool: string;
  inputSummary?: string;
  command?: string;
  output?: string;
  isError: boolean;
  subagent?: boolean;
}

export type RuntimeEvent = ThinkingDeltaRuntimeEvent | MemoryWriteRuntimeEvent | ToolResultRuntimeEvent;

export interface ModelEndpoint {
  baseUrl: string;
  token: string;
}

export interface RuntimeCapabilities {
  supportsSkills: boolean;
  // Present iff supportsSkills — the workspace-relative directory worker.ts materialises pinned
  // skills into before the turn (see skills-materialize.ts).
  skillDir?: string;
  supportsResume: boolean;
}

export interface RunInput {
  systemPrompt: string;
  model: ModelSpec;
  userText: string;
  resumeSessionRef?: string;
  skillNames?: string[];
  outputSchema?: Record<string, unknown>;
  // True for a PR-review turn. Review prompts embed PR title/body/existing comments/diff text,
  // which is attacker-influenced content, so run-turn-claude.ts uses this to gate out the
  // `remember` MCP tool for review turns - otherwise a crafted PR body could induce the agent to
  // persist attacker-chosen "lessons" that later get injected into every future run's prompt.
  isReviewTurn?: boolean;
  modelEndpoint?: ModelEndpoint;
}

export interface RepoMapResult {
  text: string;
  costUsd: number;
  tokens: number;
}

export interface RepoMapGenerator {
  model: ModelSpec;
  generate(ctx: {
    sandboxProvider: SandboxProvider;
    sandboxId: string;
    modelEndpoint: ModelEndpoint;
  }): Promise<RepoMapResult | undefined>;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  readonly repoMap?: RepoMapGenerator;
  capabilities(): RuntimeCapabilities;
  runTurn(
    input: RunInput,
    ctx: {
      sandboxProvider: SandboxProvider;
      sandboxId: string;
      onEvent?: (event: RuntimeEvent) => Promise<void>;
    },
  ): Promise<AgentTurnResult>;
}
