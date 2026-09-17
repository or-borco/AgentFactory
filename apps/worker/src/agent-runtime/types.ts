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
// dictated, mid-turn — worker.ts's onEvent handler special-cases this type to call
// writeMemoryEntry and persist a content-free MemoryWriteEvent, rather than the generic
// `createEvent(runId, seq++, event.type, { ...event })` every other runtime event goes through
// (which would otherwise leak the plaintext lesson into the unencrypted events.data column).
export interface MemoryWriteRuntimeEvent {
  type: "memory_write";
  content: string;
}

export type RuntimeEvent = ThinkingDeltaRuntimeEvent | MemoryWriteRuntimeEvent;

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
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
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
