import { query } from "@anthropic-ai/claude-agent-sdk";

// Prefixes the one line of stdout the worker actually parses (see docker-sandbox-provider.ts /
// agent-runtime.ts), so it's found deterministically even if the SDK or a tool call logs other
// noise to stdout first.
const RESULT_MARKER = "__RESULT__";
// Prefixes thinking event lines emitted to stdout for the host worker to capture and persist.
const EVENT_MARKER = "__EVENT__";
// Prefixes a structured-error line the host worker (agent-runtime.ts) checks for before falling
// back to its generic "no result line" failure — currently only used for context overflow.
const ERROR_MARKER = "__ERROR__";

async function main(): Promise<void> {
  const systemPrompt = process.env.SYSTEM_PROMPT ?? "";
  const userText = process.env.USER_TEXT ?? "";
  const model = process.env.MODEL_ID;
  const resume = process.env.RESUME_SESSION_REF || undefined;
  const skillNamesEnv = process.env.SKILL_NAMES;
  const skills = skillNamesEnv ? skillNamesEnv.split(",").filter(Boolean) : [];

  let resultText: string | undefined;
  let sessionId: string | undefined;

  // No `tools` restriction (unlike the old host-side stub) + bypassPermissions: this slice runs
  // the agent's full default toolset inside the container with no approval-gate blocking, per
  // CLAUDE.md's "no approval gates" rule. cwd scopes file tools to the scratch workspace.
  try {
    for await (const message of query({
      prompt: userText,
      options: {
        model,
        systemPrompt,
        cwd: "/workspace",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        resume,
        // Always passed, even empty — this positively disables discovery of any repo-committed
        // skills for a run whose agent has none pinned, rather than leaving the SDK to look for
        // skills on its own (see skills-materialize.ts for how the pinned ones land in
        // .claude/skills before this runs).
        skills,
        // `display` defaults to "omitted" on Sonnet 5 / Opus 5 and the 4.7+ family, which streams
        // thinking blocks with empty text — the run then shows nothing at all until the final
        // answer lands. "summarized" returns a readable summary of the reasoning instead. Thinking
        // is billed identically either way; this only controls whether we can show it.
        thinking: { type: "adaptive", display: "summarized" },
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "thinking" && block.thinking) {
            // The agent's own reasoning summary, available because the query above asks for
            // display: "summarized". Without it these blocks arrive with empty text and the run
            // looks frozen until the final answer — on a tool-less turn, nothing is emitted at all.
            process.stdout.write(`${EVENT_MARKER}${JSON.stringify({ type: "thinking_delta", text: block.thinking })}\n`);
          } else if (block.type === "tool_use") {
            // Surface tool invocations as thinking steps too — a tool call reveals what the agent
            // is doing, and it stays useful alongside the reasoning summaries above. We emit the
            // structured pieces (tool name + the agent's own `description` + the raw command +
            // target file) so the UI can render a friendly narrative ("Installing dependencies",
            // "Writing strings.ts") instead of raw shell. `text` is kept as a human-readable
            // fallback for older clients.
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Prompt is too long")) {
      process.stdout.write(`${ERROR_MARKER}${JSON.stringify({ code: "prompt_too_long" })}\n`);
      return;
    }
    // Anthropic's own wording for an exhausted account balance — matched on the API's actual
    // error text (there's no separate error type for it; see the 400 invalid_request_error
    // shape) rather than a status code, since that's all that survives through the SDK's
    // thrown error message by the time it reaches this catch.
    if (/credit balance/i.test(message)) {
      process.stdout.write(`${ERROR_MARKER}${JSON.stringify({ code: "insufficient_credit" })}\n`);
      return;
    }
    throw err;
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
