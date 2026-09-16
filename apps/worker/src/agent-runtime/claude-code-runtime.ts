import type { SandboxProvider } from "../sandbox/types";
import { SKILL_DIR } from "../skill-paths";
import { readAgentTurnOutput } from "./marker-protocol";
import type { AgentRuntime, AgentTurnResult, RunInput, RuntimeCapabilities, RuntimeEvent } from "./types";

// Mechanical move of what was apps/worker/src/agent-runtime.ts's runAgentTurn(): same env vars,
// same script, same marker protocol — now read through the shared marker-protocol.ts helper so a
// second adapter (e.g. Codex) can reuse it. No behavior change.
class ClaudeCodeRuntime implements AgentRuntime {
  readonly kind = "claude-code" as const;

  capabilities(): RuntimeCapabilities {
    return { supportsSkills: true, skillDir: SKILL_DIR, supportsResume: true };
  }

  async runTurn(
    input: RunInput,
    ctx: { sandboxProvider: SandboxProvider; sandboxId: string; onEvent?: (event: RuntimeEvent) => Promise<void> },
  ): Promise<AgentTurnResult> {
    const env: Record<string, string> = {
      SYSTEM_PROMPT: input.systemPrompt,
      USER_TEXT: input.userText,
      MODEL_ID: input.model.id,
      // Platform key passthrough for now — see ARCHITECTURE.md §9: this becomes
      // resolveCredentials(orgId) once BYO-key connections exist.
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    };
    if (input.resumeSessionRef) env.RESUME_SESSION_REF = input.resumeSessionRef;
    if (input.skillNames && input.skillNames.length > 0) env.SKILL_NAMES = input.skillNames.join(",");
    if (input.outputSchema) env.OUTPUT_SCHEMA = JSON.stringify(input.outputSchema);

    const output = ctx.sandboxProvider.exec(
      ctx.sandboxId,
      ["/agent/node_modules/.bin/tsx", "/agent/run-turn-claude.ts"],
      { env },
    );
    return readAgentTurnOutput(output, ctx.onEvent);
  }
}

export const claudeCodeRuntime: AgentRuntime = new ClaudeCodeRuntime();
