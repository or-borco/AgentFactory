import type { SandboxProvider } from "../sandbox/types";
import { SKILL_DIR } from "../skill-paths";
import { readAgentTurnOutput } from "./marker-protocol";
import { buildModelSpec } from "@agentfactory/core";
import type {
  AgentRuntime,
  AgentTurnResult,
  ModelEndpoint,
  RepoMapGenerator,
  RepoMapResult,
  RunInput,
  RuntimeCapabilities,
  RuntimeEvent,
} from "./types";

const REPO_MAP_RESULT_MARKER = "__RESULT__";

const claudeRepoMapGenerator: RepoMapGenerator = {
  model: buildModelSpec("claude-haiku-4-5"),
  async generate({ sandboxProvider, sandboxId, modelEndpoint }) {
    let stdout = "";
    for await (const chunk of sandboxProvider.exec(
      sandboxId,
      ["/agent/node_modules/.bin/tsx", "/agent/generate-repo-map.ts"],
      { env: { ...claudeModelEnv(modelEndpoint), MODEL_ID: claudeRepoMapGenerator.model.id } },
    )) {
      if (chunk.stream === "stdout") stdout += chunk.data;
    }
    const resultLine = stdout.split("\n").find((line) => line.startsWith(REPO_MAP_RESULT_MARKER));
    if (!resultLine) return undefined;
    return JSON.parse(resultLine.slice(REPO_MAP_RESULT_MARKER.length)) as RepoMapResult;
  },
};

export function claudeModelEnv(endpoint: ModelEndpoint): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ANTHROPIC_API_KEY: endpoint.token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

// Mechanical move of what was apps/worker/src/agent-runtime.ts's runAgentTurn(): same env vars,
// same script, same marker protocol — now read through the shared marker-protocol.ts helper so a
// second adapter (e.g. Codex) can reuse it. No behavior change.
class ClaudeCodeRuntime implements AgentRuntime {
  readonly kind = "claude-code" as const;
  readonly repoMap = claudeRepoMapGenerator;

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
      ...(input.modelEndpoint ? claudeModelEnv(input.modelEndpoint) : {}),
    };
    if (input.resumeSessionRef) env.RESUME_SESSION_REF = input.resumeSessionRef;
    if (input.skillNames && input.skillNames.length > 0) env.SKILL_NAMES = input.skillNames.join(",");
    if (input.outputSchema) env.OUTPUT_SCHEMA = JSON.stringify(input.outputSchema);
    // Read by run-turn-claude.ts to gate the `remember` MCP tool off for review turns - see
    // RunInput.isReviewTurn.
    if (input.isReviewTurn) env.AGENT_TURN_KIND = "review";

    const output = ctx.sandboxProvider.exec(
      ctx.sandboxId,
      ["/agent/node_modules/.bin/tsx", "/agent/run-turn-claude.ts"],
      { env },
    );
    return readAgentTurnOutput(output, ctx.onEvent);
  }
}

export const claudeCodeRuntime: AgentRuntime = new ClaudeCodeRuntime();
