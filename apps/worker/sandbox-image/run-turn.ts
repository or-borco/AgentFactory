import { query } from "@anthropic-ai/claude-agent-sdk";

// Prefixes the one line of stdout the worker actually parses (see docker-sandbox-provider.ts /
// agent-runtime.ts), so it's found deterministically even if the SDK or a tool call logs other
// noise to stdout first.
const RESULT_MARKER = "__RESULT__";
// Prefixes thinking event lines emitted to stdout for the host worker to capture and persist.
const EVENT_MARKER = "__EVENT__";

async function main(): Promise<void> {
  const systemPrompt = process.env.SYSTEM_PROMPT ?? "";
  const userText = process.env.USER_TEXT ?? "";
  const model = process.env.MODEL_ID;
  const resume = process.env.RESUME_SESSION_REF || undefined;

  let resultText: string | undefined;
  let sessionId: string | undefined;

  // No `tools` restriction (unlike the old host-side stub) + bypassPermissions: this slice runs
  // the agent's full default toolset inside the container with no approval-gate blocking, per
  // CLAUDE.md's "no approval gates" rule. cwd scopes file tools to the scratch workspace.
  for await (const message of query({
    prompt: userText,
    options: {
      model,
      systemPrompt,
      cwd: "/workspace",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      resume,
      thinking: { type: "adaptive" },
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          // Surface tool invocations as thinking steps — the agent's narrated reasoning.
          // The SDK redacts internal thinking text (thinking blocks always have empty .thinking),
          // but each tool call reveals what the agent is doing. We emit the structured pieces
          // (tool name + the agent's own `description` + the raw command + target file) so the
          // UI can render a friendly narrative ("Installing dependencies", "Writing strings.ts")
          // instead of raw shell. `text` is kept as a human-readable fallback for older clients.
          const input = block.input as Record<string, unknown>;
          const description = typeof input.description === "string" ? input.description : undefined;
          const command = typeof input.command === "string" ? input.command : undefined;
          const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
          const fallback = description ?? command ?? (filePath ? `${block.name}: ${filePath}` : block.name);
          process.stdout.write(
            `${EVENT_MARKER}${JSON.stringify({
              type: "thinking_delta",
              tool: block.name,
              description,
              command,
              filePath,
              text: `[${block.name}] ${fallback}\n`,
            })}\n`,
          );
        }
      }
    } else if (message.type === "result") {
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

  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ text: resultText, providerSessionRef: sessionId })}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
