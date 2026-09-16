import type { ModelSpec, RuntimeKind } from "@agentfactory/core";
import type { SandboxProvider } from "../sandbox/types";

export interface AgentTurnResult {
  text: string;
  providerSessionRef: string;
}

// Named RuntimeEvent, not RunEvent, to avoid colliding with @agentfactory/core's RunEvent (the
// persisted event row, with id/runId/seq/createdAt) — this is the raw shape a runtime emits
// before worker.ts wraps it into a stored event via createEvent().
export interface RuntimeEvent {
  type: "thinking_delta";
  text: string;
  tool?: string;
  description?: string;
  command?: string;
  filePath?: string;
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
