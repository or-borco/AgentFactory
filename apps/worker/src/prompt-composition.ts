import { createHash } from "node:crypto";
import type { ChatMessage, PromptSegment } from "@agentfactory/core";
import { TASK_DOCUMENT_DIR } from "./task-document-paths";

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

// Sibling to PLATFORM_PREAMBLE for review runs — deliberately does NOT say "commit and open a
// PR": a review run never commits, pushes, or has push credentials in the sandbox at all. It
// also tells the agent up front how its answer reaches GitHub, since the agent otherwise has no
// way to know its final message is parsed as structured data rather than read as prose.
export const REVIEW_PLATFORM_PREAMBLE =
  "You are an AgentFactory agent, reviewing a GitHub pull request. You run inside a sandboxed, " +
  "read-only git checkout of the PR — you have no credentials to write to the remote repository " +
  "and should not attempt to modify it in any way. Read the code as thoroughly as you need to " +
  "(the full checkout is available, not just the diff). End your turn with a structured review: " +
  "a short summary, a verdict of either 'comment' or 'request_changes', and a list of inline " +
  "comments anchored to specific files and line numbers. The platform posts this as a real " +
  "GitHub review after your turn ends — you never call GitHub yourself.\n\n---\n\n";

export interface SandboxEnvironment {
  // Absolute path of the checkout inside the sandbox, or undefined when this run has no codebase
  // attached at all (a chat-only session — /workspace exists but holds no repo).
  workspacePath?: string;
  // The branch cloneIntoSandbox checked out for this session; the agent is expected to stay on it.
  branch?: string;
  // Whether the worker already resolved a linked GitHub issue and appended it to the user text —
  // the difference between "the issue is below" and "the issue could not be retrieved at all".
  hasIssueContext?: boolean;
  // What materialiseTaskDocuments actually wrote into the checkout, and what did not fit. Stating
  // both is the point: naming only the files present would let the agent read the directory as
  // the complete set of what a human attached.
  taskDocuments?: { written: string[]; omitted: string[] };
  // Set only for the two syncWithDefaultBranch outcomes worth telling the agent about (see
  // scm-provider.ts) — "synced" so it knows why code may look different from its last turn here,
  // "skipped_conflict" because that one recurs on every future run until someone resolves it, so
  // the agent needs to keep hearing about it rather than it going silently stale forever.
  repoSync?:
    | { status: "synced"; commitsMerged: number }
    | { status: "skipped_conflict"; conflictingFiles: string[] };
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

    // Aimed squarely at the failure this exists to prevent: on run 27 the agent searched for an
    // attached spec with `find / -iname "*retry-spec*"`, found nothing, and settled for the
    // retrieval excerpts — 22% of a document the platform was holding in full the whole time.
    // Any excerpts of these same documents also appear in the retrieved-context layer below, so
    // the agent is told which is the complete copy rather than left to guess.
    const written = env.taskDocuments?.written ?? [];
    const omitted = env.taskDocuments?.omitted ?? [];
    if (written.length > 0) {
      lines.push(
        `- The files attached to this task are already in your checkout at ` +
          `\`${env.workspacePath}/${TASK_DOCUMENT_DIR}\`: ${written
            .map((path) => `\`${path}\``)
            .join(", ")}. These are the complete files — open them directly rather than searching ` +
          "for them (view an image, read a text document), and prefer them over any excerpt of the " +
          "same document quoted elsewhere in this prompt. They are untracked and excluded from " +
          "git; leave them out of your commits.",
      );
    }
    if (omitted.length > 0) {
      lines.push(
        `- Attached to this task but NOT available in your checkout: ${omitted
          .map((title) => `"${title}"`)
          .join(", ")}. Excerpts may still appear below, but the full text is not on disk — say so ` +
          "if you need it rather than assuming the files you can see are everything.",
      );
    }
  }

  lines.push(
    env.hasIssueContext
      ? "- The linked GitHub issue's title and body have been resolved for you and appear at the end " +
          "of the user message below."
      : "- If something you need is genuinely unavailable here, say so plainly in your final response " +
          "rather than spending the turn trying to fetch it.",
  );

  if (env.repoSync?.status === "synced") {
    const { commitsMerged } = env.repoSync;
    lines.push(
      `- This task's checkout was just synced with ${commitsMerged} new commit` +
        `${commitsMerged === 1 ? "" : "s"} from the default branch before this turn began. Code you ` +
        "remember from an earlier turn in this session may have changed.",
    );
  }
  if (env.repoSync?.status === "skipped_conflict") {
    lines.push(
      "- The default branch has moved on since this checkout was created, but syncing it in failed " +
        `due to conflicts in: ${env.repoSync.conflictingFiles.join(", ")}. This will keep failing on ` +
        "every future turn until it's resolved — mention this, or resolve it yourself if it's " +
        "relevant to what you're doing.",
    );
  }

  return `## Environment (platform-authored, authoritative)\n\n${lines.join("\n")}\n\n---\n\n`;
}

export interface ReviewEnvironment {
  workspacePath: string;
  prNumber: number;
  focusBaseSha: string;
  focusHeadSha: string;
  rewritten: boolean;
  truncatedDiff: boolean;
}

// The review-run equivalent of formatEnvironmentForPrompt — states what the dev-run version
// states (checkout location, "don't go looking for it"), but describes a PR range to review
// instead of a branch to work on, and never mentions committing or pushing.
export function formatReviewEnvironmentForPrompt(env: ReviewEnvironment): string {
  const lines: string[] = [
    `- Your git checkout is at \`${env.workspacePath}\`, checked out at pull request #${env.prNumber}'s ` +
      "current head. Do not search the filesystem for it.",
    `- Focus your review on the range \`${env.focusBaseSha}\`..\`${env.focusHeadSha}\`. The full PR diff ` +
      "for that range is included below.",
  ];
  if (env.rewritten) {
    lines.push(
      "- This PR's branch history was rewritten (force-pushed) since the last review, so the range " +
        "above covers the whole PR again rather than just what changed since last time — your prior " +
        "comments may no longer apply cleanly to the new history.",
    );
  }
  if (env.truncatedDiff) {
    lines.push(
      "- The diff below was truncated because this PR is very large. Use `git diff` yourself in the " +
        "checkout to see the rest before finishing your review.",
    );
  }
  return `## Environment\n\n${lines.join("\n")}\n\n---\n\n`;
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
// different bugs: no source to search at all (retrieval never ran), a source that has uploaded
// nothing that finished indexing, and a source whose documents had nothing selected for this
// task (nothing above the similarity floor on the team side, nothing fit the reserved budget on
// the task side). The fourth state — retrieval threw — is not derivable from these booleans;
// only retrieveContext knows it, and worker.ts uses its reason directly for that one case.
//
// hasSource is `Boolean(team) || Boolean(task)`, not `Boolean(team)` alone — a teamless task with
// its own documents is a real source too. This is deliberately a different signal from the
// team_context (Layer 1 / shared_context) segment's own "no_team", which stays exactly as-is:
// that segment has no task-sourced equivalent, so "agent has no team" remains completely accurate
// there. Here, "neither a team nor a task resolved" gets its own code, no_context_sources, so it
// is never confused with "a team resolved but its shared context is blank" or with the retrieved
// segment's other omission states.
export function buildRetrievedContextSegment(
  hasSource: boolean,
  hasIndexedDocuments: boolean,
  wrapped: string,
): PromptSegment {
  if (wrapped) return { id: "retrieved_context", text: wrapped };
  if (!hasSource) return { id: "retrieved_context", text: "", omittedReason: "no_context_sources" };
  if (!hasIndexedDocuments) {
    return { id: "retrieved_context", text: "", omittedReason: "no_indexed_documents" };
  }
  return { id: "retrieved_context", text: "", omittedReason: "no_relevant_chunks" };
}

const PRIOR_CONVERSATION_BUDGET_BYTES = 32 * 1024;

// Reconstructs enough prior-turn context for the model to continue coherently when a session's
// sandbox has been recreated (docs/superpowers/specs/2026-09-08-session-context-reconstruction-
// design.md) and `resume` can no longer work — the Claude Agent SDK's resume state lives in the
// old, now-destroyed container's filesystem, not server-side. `excludeMessageId` is this run's
// own triggering message: it's sent as `userText` the normal way, so including it here too would
// just duplicate it.
//
// Walks messages newest-first accumulating against the byte budget, then reverses back to
// chronological order — the most recent turns are what the model most needs to pick up where it
// left off, so they're the ones guaranteed to survive truncation, not the oldest. `messages` is
// assumed chronological (oldest first), matching listMessages's contract.
export function formatPriorConversationForPrompt(messages: ChatMessage[], excludeMessageId: number): string {
  const relevant = messages.filter((m) => m.id !== excludeMessageId);
  if (relevant.length === 0) return "";

  const kept: ChatMessage[] = [];
  let bytes = 0;
  let truncated = false;
  for (let i = relevant.length - 1; i >= 0; i--) {
    const message = relevant[i];
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${message.content}\n\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > PRIOR_CONVERSATION_BUDGET_BYTES) {
      truncated = true;
      break;
    }
    kept.unshift(message);
    bytes += lineBytes;
  }
  if (kept.length === 0) return "";

  const body = kept.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  const trimNote = truncated ? "\n\n[earlier messages omitted for length]" : "";
  return (
    "## Prior Conversation (reconstructed — the sandbox that held this conversation's state was " +
    `reclaimed; this is the message history so far)\n\n${body}${trimNote}\n\n---\n\n`
  );
}

// resumeIsValid distinguishes "resume was used normally, this segment doesn't apply"
// (resume_valid) from "resume wasn't valid but there's no history yet" — the session's
// first-ever run, or no run has ever recorded a ref — (no_prior_conversation). Both render as
// omitted, but for different, auditable reasons, matching the existing pattern for
// team_context/repo_map.
export function buildPriorConversationSegment(resumeIsValid: boolean, formatted: string): PromptSegment {
  if (formatted) return { id: "prior_conversation", text: formatted };
  return {
    id: "prior_conversation",
    text: "",
    omittedReason: resumeIsValid ? "resume_valid" : "no_prior_conversation",
  };
}

// Order per ARCHITECTURE.md §3, narrowed to this repo's actual scope. Skills are not a prompt
// segment: a pinned skill is materialized into the sandbox and handed to the SDK via query()'s
// own `skills` option (see skills-materialize.ts), so this function's segment list is unchanged
// by design, not by omission. Three rules decide the arrangement of the segments that remain:
//
// 1. Platform-authored constraints lead. The preamble and the environment brief describe hard
//    facts about the sandbox, so they must not read as something team context or the agent's
//    own prompt could override. priorConversation sits right after environment for the same
//    reason: it's platform-observable fact about what already happened (not a team-authored
//    instruction, not machine-selected reference material), read in light of the environment
//    facts that precede it, not the reverse.
// 2. Human-authored instructions go LAST, with machine-generated reference material before
//    them. The repo map is descriptive bulk (capped at 16 KB, routinely 60-70% of the whole
//    prompt); team context and the agent's system prompt are what a human actually wrote and
//    expects to be obeyed. Putting the map between them buries the team's instructions.
// 3. Retrieved document excerpts sit between the two. They are human-written prose but
//    machine-SELECTED bulk, and they are more task-specific than the repo map, so they go after
//    the map and before team context. This supersedes ARCHITECTURE.md §3, which puts retrieved
//    items after shared_context — that ordering predates the measurement below. The re-run with
//    a retrieved layer present (docs/superpowers/experiments/2026-08-27-retrieved-layer-ordering.md)
//    did not falsify this order — Arm B (the §3 order) scored no worse, 10/10 vs 9/10 — but that
//    is one task shape with no imperative team-context instruction and no long tool transcript,
//    so it is inconclusive rather than a strong confirmation.
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
  preamble: string,
  environment: string,
  priorConversation: PromptSegment,
  teamContext: PromptSegment,
  repoMap: PromptSegment,
  retrievedContext: PromptSegment,
  agentSystemPrompt: string,
): ComposedPrompt {
  const segments: PromptSegment[] = [
    { id: "platform_preamble", text: preamble },
    { id: "environment", text: environment },
    priorConversation,
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
