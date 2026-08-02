import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "@agentfactory/core";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function callClaude(
  systemPrompt: string,
  modelId: string,
  maxTokens: number,
  history: ChatMessage[],
): Promise<string> {
  const messages = history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const response = await client.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type from Claude");
  return block.text;
}
