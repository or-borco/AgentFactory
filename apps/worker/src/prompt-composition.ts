import { createHash } from "node:crypto";
import type { PromptSegment } from "@agentfactory/core";

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

export interface SandboxEnvironment {
  // Absolute path of the checkout inside the sandbox, or undefined when this run has no codebase
  // attached at all (a chat-only session — /workspace exists but holds no repo).
  workspacePath?: string;
  // The branch cloneIntoSandbox checked out for this session; the agent is expected to stay on it.
  branch?: string;
  // Whether the worker already resolved a linked GitHub issue and appended it to the user text —
  // the difference between "the issue is below" and "the issue could not be retrieved at all".
  hasIssueContext?: boolean;
}

// Facts about the container the turn runs in, stated up front because the agent otherwise
// discovers them by trial and error at real wall-clock cost. Measured on run 32 of the perf
// review: ~9s spent running `find /` to locate its own checkout, then ~40s cycling through
// `git fetch`, `gh`, and three `WebFetch` calls to the GitHub API before concluding it had no
// network credentials — 60% of that turn's model time, on an environment that is fixed and known
// to the worker before the turn starts. cloneIntoSandbox deliberately strips the installation
// token from the git remote, and the sandbox image ships no `gh`, `curl`, or `wget`, so every one
// of those attempts is guaranteed to fail; the only fix is to say so before the agent tries.
export function formatEnvironmentForPrompt(env: SandboxEnvironment): string {
  const lines: string[] = [];

  if (env.workspacePath) {
    lines.push(
      `- Your git checkout is at \`${env.workspacePath}\`, which is already your working directory. ` +
        "Do not search the filesystem for it.",
    );
    if (env.branch) {
      lines.push(
        `- You are on branch \`${env.branch}\`. Commit your work there and stay on it — the platform ` +
          "pushes the branch and opens the pull request for you once your turn ends, so you never " +
          "need to push or open a PR yourself.",
      );
    }
  } else {
    lines.push(
      "- No repository is checked out for this session. There is no code to read; answer from the " +
        "conversation and the context in this prompt.",
    );
  }

  lines.push(
    "- You have no network access to GitHub or any other host: there are no git credentials, no " +
      "`gh` CLI, and no `curl`/`wget`. `git fetch`, `git ls-remote`, `git push`, and web requests to " +
      "the GitHub API will all fail. Do not attempt them, and do not reach for `WebFetch` as a " +
      "substitute — it fails the same way.",
  );

  if (env.workspacePath) {
    lines.push(
      "- Everything knowable about the remote repository is already in this checkout's local git " +
        "history (`git log`, `git tag`, `git show`) or stated in this prompt. Pull requests, issues, " +
        "and releases that are not present locally cannot be retrieved.",
    );
  }

  lines.push(
    env.hasIssueContext
      ? "- The linked GitHub issue's title and body have been resolved for you and appear at the end " +
          "of the user message below."
      : "- If something you need is genuinely unavailable here, say so plainly in your final response " +
          "rather than spending the turn trying to fetch it.",
  );

  return `## Environment (platform-authored, authoritative)\n\n${lines.join("\n")}\n\n---\n\n`;
}

export interface ComposedPrompt {
  segments: PromptSegment[];
  prompt: string; // invariant: segments.map((s) => s.text).join("")
}

// Team-context segment for a run. The worker is the only place that knows WHY the
// layer is empty — no team at all vs. a team whose shared context is blank — and
// those are different bugs, so the reason is recorded here, not inferred in the UI.
export function buildTeamContextSegment(hasTeam: boolean, formatted: string): PromptSegment {
  if (formatted) return { id: "team_context", text: formatted };
  return { id: "team_context", text: "", omittedReason: hasTeam ? "empty_shared_context" : "no_team" };
}

// Repo-map segment: chat-only session (no codebase) vs. cache miss with
// generation deferred to a background job (see repo-map.ts).
export function buildRepoMapSegment(hasCodebase: boolean, wrapped: string): PromptSegment {
  if (wrapped) return { id: "repo_map", text: wrapped };
  return { id: "repo_map", text: "", omittedReason: hasCodebase ? "repo_map_pending" : "no_codebase" };
}

// Order per ARCHITECTURE.md §3, extended with the repo map (docs/superpowers/specs/
// 2026-08-23-repo-map-indexing-design.md) between team context and the agent's own prompt —
// narrowed to this repo's actual scope: no retrieved context items, no skills index yet. The
// environment brief sits directly after the preamble: like the preamble it is platform-authored
// and describes hard constraints, so it must not be readable as something team context or the
// agent's own prompt could override.
//
// Returns the segments alongside the joined prompt so the caller can persist exactly what was
// sent (runs.prompt_segments) — `prompt` is derived from `segments`, never built separately, so
// the stored record cannot drift from the sent string.
export function composeSystemPrompt(
  environment: string,
  teamContext: PromptSegment,
  repoMap: PromptSegment,
  agentSystemPrompt: string,
): ComposedPrompt {
  const segments: PromptSegment[] = [
    { id: "platform_preamble", text: PLATFORM_PREAMBLE },
    { id: "environment", text: environment },
    teamContext,
    repoMap,
    { id: "agent_system_prompt", text: agentSystemPrompt },
  ];
  return { segments, prompt: segments.map((s) => s.text).join("") };
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
