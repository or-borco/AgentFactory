import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSpec } from "@agentfactory/core";

export interface AgentTurnResult {
  text: string;
  providerSessionRef: string;
}

// The real AgentRuntime call, replacing the old canned-reply stub. `tools: []`
// disables every built-in Claude Code tool (Read/Write/Bash/...) — this agent
// only produces a chat reply, it doesn't touch a filesystem or sandbox yet
// (that's DockerSandboxProvider/ClaudeCodeRuntime territory per ARCHITECTURE.md
// §1, still ahead). `resumeSessionRef` carries the prior turn's provider session
// id (from runs.provider_session_ref) so multi-turn context comes from the SDK's
// own session persistence rather than us reconstructing history by hand.
export async function runAgentTurn(params: {
  systemPrompt: string;
  model: ModelSpec;
  userText: string;
  resumeSessionRef?: string;
}): Promise<AgentTurnResult> {
  const { systemPrompt, model, userText, resumeSessionRef } = params;

  let resultText: string | undefined;
  let sessionId: string | undefined;

  for await (const message of query({
    prompt: userText,
    options: {
      model: model.id,
      systemPrompt,
      tools: [],
      resume: resumeSessionRef,
    },
  })) {
    if (message.type === "result") {
      sessionId = message.session_id;
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        throw new Error(`Claude Agent SDK run failed: ${message.subtype} (${message.errors.join(", ") || "no details"})`);
      }
    }
  }

  if (resultText === undefined || sessionId === undefined) {
    throw new Error("Claude Agent SDK query completed without a result message");
  }

  return { text: resultText, providerSessionRef: sessionId };
}
