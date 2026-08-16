import { createHash } from "node:crypto";

// ARCHITECTURE.md §3: the platform, not the SDK, owns prompt assembly so team context and
// (eventually) skills behave identically across runtimes. Deliberately short — this is not the
// place for elaborate prompt engineering, just identity, safety/scope framing, and output
// conventions the runtime can't otherwise assume.
export const PLATFORM_PREAMBLE =
  "You are an AgentFactory agent, an autonomous coding assistant delegated real engineering " +
  "work by a team. You run inside a sandboxed git checkout with no human approving actions in " +
  "real time, so stay within the scope of the task you were given. When your work is ready, " +
  "commit it and open a pull request rather than pushing directly to a protected branch. Keep " +
  "your final response concise — it is shown to the team as the run's summary.\n\n---\n\n";

// Order per ARCHITECTURE.md §3 (narrowed to this issue's scope: no retrieved context items,
// no skills index yet — see runs.prompt_hash comment on why the whole thing is hashed).
export function composeSystemPrompt(teamContextPrefix: string, agentSystemPrompt: string): string {
  return PLATFORM_PREAMBLE + teamContextPrefix + agentSystemPrompt;
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
