import { query } from "@anthropic-ai/claude-agent-sdk";

// Prefixes the one line of stdout the worker actually parses (see docker-sandbox-provider.ts /
// agent-runtime.ts), so it's found deterministically even if the SDK or a tool call logs other
// noise to stdout first.
const RESULT_MARKER = "__RESULT__";

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

  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ text: resultText, providerSessionRef: sessionId })}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
