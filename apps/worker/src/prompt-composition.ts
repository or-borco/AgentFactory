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

// Retrieved-context segment. Three distinguishable "nothing was injected" states, and they are
// different bugs: no team at all (retrieval never ran), a team that has uploaded nothing that
// finished indexing, and a team whose documents had nothing above the similarity floor for this
// task. The fourth state — retrieval threw — is not derivable from these booleans; only
// retrieveContext knows it, and worker.ts uses its reason directly for that one case.
export function buildRetrievedContextSegment(
  hasTeam: boolean,
  hasIndexedDocuments: boolean,
  wrapped: string,
): PromptSegment {
  if (wrapped) return { id: "retrieved_context", text: wrapped };
  if (!hasTeam) return { id: "retrieved_context", text: "", omittedReason: "no_team" };
  if (!hasIndexedDocuments) {
    return { id: "retrieved_context", text: "", omittedReason: "no_indexed_documents" };
  }
  return { id: "retrieved_context", text: "", omittedReason: "no_relevant_chunks" };
}

// Order per ARCHITECTURE.md §3, narrowed to this repo's actual scope: no skills index yet. Three
// rules decide the arrangement:
//
// 1. Platform-authored constraints lead. The preamble and the environment brief describe hard
//    facts about the sandbox, so they must not read as something team context or the agent's
//    own prompt could override.
// 2. Human-authored instructions go LAST, with machine-generated reference material before
//    them. The repo map is descriptive bulk (capped at 16 KB, routinely 60-70% of the whole
//    prompt); team context and the agent's system prompt are what a human actually wrote and
//    expects to be obeyed. Putting the map between them buries the team's instructions.
// 3. Retrieved document excerpts sit between the two. They are human-written prose but
//    machine-SELECTED bulk, and they are more task-specific than the repo map, so they go after
//    the map and before team context. This supersedes ARCHITECTURE.md §3, which puts retrieved
//    items after shared_context — that ordering predates the measurement below. Rule 3 is a
//    hypothesis, not a measurement: re-running the layer-ordering experiment with a retrieved
//    layer present is a PR 7 concern.
//
// Rule 2 is measured, not assumed. The repo map used to sit between team context and the agent
// prompt. Replaying a real run's exact layers against claude-haiku-4-5 and scoring the output
// against every instruction those layers contained (docs/superpowers/experiments/
// 2026-08-26-prompt-layer-ordering.md) gave, for fully-compliant responses:
//
//     map between team context and agent prompt   1/10
//     map before both (this order)               10/10
//
// The gap is almost entirely the team-context instructions, and it widens — not narrows — once
// a long tool-use transcript sits between the system prompt and the answer, which is the normal
// condition for a real run. The reordering costs nothing: identical bytes, identical content.
// An appended "requirements checklist" was also tried and scored worse than reordering alone,
// so it was not adopted.
//
// Returns the segments alongside the joined prompt so the caller can persist exactly what was
// sent (runs.prompt_segments) — `prompt` is derived from `segments`, never built separately, so
// the stored record cannot drift from the sent string.
export function composeSystemPrompt(
  environment: string,
  teamContext: PromptSegment,
  repoMap: PromptSegment,
  retrievedContext: PromptSegment,
  agentSystemPrompt: string,
): ComposedPrompt {
  const segments: PromptSegment[] = [
    { id: "platform_preamble", text: PLATFORM_PREAMBLE },
    { id: "environment", text: environment },
    repoMap,
    retrievedContext,
    teamContext,
    { id: "agent_system_prompt", text: agentSystemPrompt },
  ];
  return { segments, prompt: segments.map((s) => s.text).join("") };
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
