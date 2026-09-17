import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Prefixes the one line of stdout the worker actually parses (see docker-sandbox-provider.ts /
// agent-runtime.ts), so it's found deterministically even if the SDK or a tool call logs other
// noise to stdout first.
const RESULT_MARKER = "__RESULT__";
// Prefixes thinking event lines emitted to stdout for the host worker to capture and persist.
const EVENT_MARKER = "__EVENT__";
// Prefixes a structured-error line the host worker (agent-runtime.ts) checks for before falling
// back to its generic "no result line" failure — currently only used for context overflow.
const ERROR_MARKER = "__ERROR__";

// The first custom in-process tool in this codebase (see the design spec's ground truth: no
// mcpServers option existed before this). Handler only writes an __EVENT__ line and returns
// immediately. No DB call happens inside the sandbox, matching every other tool call's
// isolation from the host's database credentials. The host worker (worker.ts's onEvent handler)
// is what actually calls writeMemoryEntry and persists the event.
const rememberTool = tool(
  "remember",
  "Save a concise lesson for your own future sessions with this agent. Use this when the user " +
    "explicitly asks you to remember something, or when you notice something worth carrying " +
    "forward (a correction, a recurring failure mode). Keep it general and reusable, not specific " +
    "to this one task's business logic.",
  { content: z.string().describe("A concise, general lesson, at most a few sentences.") },
  async ({ content }) => {
    process.stdout.write(`${EVENT_MARKER}${JSON.stringify({ type: "memory_write", content })}\n`);
    return { content: [{ type: "text", text: "Noted for future sessions." }] };
  },
);

const memoryMcpServer = createSdkMcpServer({
  name: "memory",
  tools: [rememberTool],
});

async function main(): Promise<void> {
  const systemPrompt = process.env.SYSTEM_PROMPT ?? "";
  const userText = process.env.USER_TEXT ?? "";
  const model = process.env.MODEL_ID;
  const resume = process.env.RESUME_SESSION_REF || undefined;
  const skillNamesEnv = process.env.SKILL_NAMES;
  const skills = skillNamesEnv ? skillNamesEnv.split(",").filter(Boolean) : [];
  const outputSchemaEnv = process.env.OUTPUT_SCHEMA;
  const outputFormat = outputSchemaEnv
    ? ({ type: "json_schema", schema: JSON.parse(outputSchemaEnv) } as const)
    : undefined;
  // Set by worker.ts (via claude-code-runtime.ts's AGENT_TURN_KIND env var) only for PR-review
  // turns. Review prompts embed PR title/body/existing comments/diff text - content this codebase
  // already treats elsewhere as untrusted and attacker-influenced - so the `remember` tool must
  // not be reachable on this path: a crafted PR body could otherwise induce the agent to persist
  // attacker-chosen "lessons" that get injected into every future run's system prompt for this
  // agent, including non-review coding runs.
  const isReviewTurn = process.env.AGENT_TURN_KIND === "review";

  let resultText: string | undefined;
  let sessionId: string | undefined;
  let structuredOutput: unknown;

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
        // `remember` (the memory MCP server) is omitted entirely on a review turn - see
        // isReviewTurn above. Not testable in-process (this script executes the real SDK query()
        // top-level on import, and this package - apps/worker/sandbox-image - has no test runner
        // of its own and isn't in the unit vitest project's include glob); the AGENT_TURN_KIND
        // env-var wiring that drives this flag is covered by
        // apps/worker/src/__tests__/claude-code-runtime.test.ts instead.
        mcpServers: isReviewTurn ? {} : { memory: memoryMcpServer },
        // `display` defaults to "omitted" on Sonnet 5 / Opus 5 and the 4.7+ family, which streams
        // thinking blocks with empty text — the run then shows nothing at all until the final
        // answer lands. "summarized" returns a readable summary of the reasoning instead. Thinking
        // is billed identically either way; this only controls whether we can show it.
        thinking: { type: "adaptive", display: "summarized" },
        ...(outputFormat ? { outputFormat } : {}),
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
          structuredOutput = message.structured_output;
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

  process.stdout.write(
    `${RESULT_MARKER}${JSON.stringify({
      text: resultText,
      providerSessionRef: sessionId,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    })}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
