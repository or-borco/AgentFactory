import { query } from "@anthropic-ai/claude-agent-sdk";

// Prefixes the one line of stdout the worker parses (see apps/worker/src/repo-map.ts).
const RESULT_MARKER = "__RESULT__";

const PROMPT =
  "Explore this repository and produce a concise map for a coding agent that has never seen it " +
  "before: the directory structure and what each top-level area is for, key entry points, " +
  "build/test/lint commands, and any non-obvious conventions a new contributor would need. " +
  "Do not describe files one by one. Stay under 800 words.";

async function main(): Promise<void> {
  let resultText: string | undefined;
  let costUsd = 0;
  let tokens = 0;

  // No `thinking` option (unlike run-turn.ts) — this call's job is a quick orientation summary,
  // not careful reasoning, and thinking tokens would work against the "cheap and bounded" point
  // of running this on a fixed low-cost model in the first place.
  for await (const message of query({
    prompt: PROMPT,
    options: {
      model: "claude-haiku-4-5",
      cwd: "/workspace",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result;
        costUsd = message.total_cost_usd;
        tokens = message.usage.input_tokens + message.usage.output_tokens;
      } else {
        throw new Error(`Repo map generation failed: ${message.subtype} (${message.errors.join(", ") || "no details"})`);
      }
    }
  }

  if (resultText === undefined) {
    throw new Error("Claude Agent SDK query completed without a result message");
  }

  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ text: resultText, costUsd, tokens })}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
