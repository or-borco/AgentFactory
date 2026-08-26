import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PromptSegment } from "@agentfactory/core";
import {
  PLATFORM_PREAMBLE,
  buildRepoMapSegment,
  buildTeamContextSegment,
  composeSystemPrompt,
  formatEnvironmentForPrompt,
  hashPrompt,
} from "../prompt-composition";

const teamSeg = (text: string): PromptSegment => ({ id: "team_context", text });
const repoSeg = (text: string): PromptSegment => ({ id: "repo_map", text });

describe("composeSystemPrompt", () => {
  it("orders platform preamble, then environment, then team context, then repo map, then agent system prompt", () => {
    const { prompt } = composeSystemPrompt(
      "## Environment\n\nCheckout is at /workspace.\n\n---\n\n",
      teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"),
      repoSeg("## Repo Map\n\nThis is a monorepo.\n\n---\n\n"),
      "You are a reviewer.",
    );

    const preambleIndex = prompt.indexOf(PLATFORM_PREAMBLE);
    const environmentIndex = prompt.indexOf("Checkout is at /workspace.");
    const teamIndex = prompt.indexOf("Use pnpm.");
    const repoMapIndex = prompt.indexOf("This is a monorepo.");
    const agentIndex = prompt.indexOf("You are a reviewer.");

    expect(preambleIndex).toBe(0);
    expect(environmentIndex).toBeGreaterThan(preambleIndex);
    expect(teamIndex).toBeGreaterThan(environmentIndex);
    expect(repoMapIndex).toBeGreaterThan(teamIndex);
    expect(agentIndex).toBeGreaterThan(repoMapIndex);
  });

  it("still leads with the platform preamble when every optional section is empty", () => {
    const { prompt } = composeSystemPrompt("", teamSeg(""), repoSeg(""), "You are a reviewer.");
    expect(prompt).toBe(PLATFORM_PREAMBLE + "You are a reviewer.");
  });

  it("omits the repo map cleanly when empty, without changing prior behavior", () => {
    const { prompt } = composeSystemPrompt(
      "",
      teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"),
      repoSeg(""),
      "You are a reviewer.",
    );
    expect(prompt).toBe(PLATFORM_PREAMBLE + "## Team Context\n\nUse pnpm.\n\n---\n\n" + "You are a reviewer.");
  });

  // The core guarantee of the whole feature: the stored record IS the sent prompt.
  it("returns segments whose joined texts are byte-identical to the prompt, for every omission combination", () => {
    const cases = [
      { team: teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"), repo: repoSeg("## Repo Map\n\nMonorepo.\n\n---\n\n") },
      { team: { id: "team_context", text: "", omittedReason: "no_team" as const }, repo: repoSeg("## Repo Map\n\nMonorepo.\n\n---\n\n") },
      { team: teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"), repo: { id: "repo_map", text: "", omittedReason: "no_codebase" as const } },
      { team: { id: "team_context", text: "", omittedReason: "empty_shared_context" as const }, repo: { id: "repo_map", text: "", omittedReason: "repo_map_pending" as const } },
    ];
    for (const c of cases) {
      const { segments, prompt } = composeSystemPrompt("## Environment\n\n---\n\n", c.team, c.repo, "You are a reviewer.");
      expect(segments.map((s) => s.text).join("")).toBe(prompt);
      expect(segments.map((s) => s.id)).toEqual([
        "platform_preamble",
        "environment",
        "team_context",
        "repo_map",
        "agent_system_prompt",
      ]);
    }
  });

  it("passes the caller's omission reasons through and never marks unconditional segments omitted", () => {
    const { segments } = composeSystemPrompt(
      "",
      { id: "team_context", text: "", omittedReason: "no_team" },
      { id: "repo_map", text: "", omittedReason: "no_codebase" },
      "You are a reviewer.",
    );
    const byId = new Map(segments.map((s) => [s.id, s]));
    expect(byId.get("team_context")?.omittedReason).toBe("no_team");
    expect(byId.get("repo_map")?.omittedReason).toBe("no_codebase");
    expect(byId.get("platform_preamble")?.omittedReason).toBeUndefined();
    expect(byId.get("environment")?.omittedReason).toBeUndefined();
    expect(byId.get("agent_system_prompt")?.omittedReason).toBeUndefined();
  });
});

describe("segment builders", () => {
  it("buildTeamContextSegment distinguishes no-team from empty shared context", () => {
    expect(buildTeamContextSegment(false, "")).toEqual({ id: "team_context", text: "", omittedReason: "no_team" });
    expect(buildTeamContextSegment(true, "")).toEqual({ id: "team_context", text: "", omittedReason: "empty_shared_context" });
    expect(buildTeamContextSegment(true, "## Team Context\n\nUse pnpm.\n\n---\n\n")).toEqual({
      id: "team_context",
      text: "## Team Context\n\nUse pnpm.\n\n---\n\n",
    });
  });

  it("buildRepoMapSegment distinguishes chat-only sessions from a pending map", () => {
    expect(buildRepoMapSegment(false, "")).toEqual({ id: "repo_map", text: "", omittedReason: "no_codebase" });
    expect(buildRepoMapSegment(true, "")).toEqual({ id: "repo_map", text: "", omittedReason: "repo_map_pending" });
    expect(buildRepoMapSegment(true, "## Repo Map\n\nMonorepo.\n\n---\n\n")).toEqual({
      id: "repo_map",
      text: "## Repo Map\n\nMonorepo.\n\n---\n\n",
    });
  });
});

// These assertions are the perf fix itself, not decoration: each line exists to pre-empt a tool
// call that run 32 actually made and wasted wall-clock time on (see formatEnvironmentForPrompt).
describe("formatEnvironmentForPrompt", () => {
  it("states the checkout path and branch so the agent never searches the filesystem for them", () => {
    const result = formatEnvironmentForPrompt({ workspacePath: "/workspace", branch: "agent/session-32" });

    expect(result).toContain("/workspace");
    expect(result).toContain("agent/session-32");
    expect(result).toContain("Do not search the filesystem for it.");
  });

  it("rules out every remote-access route the sandbox actually lacks", () => {
    const result = formatEnvironmentForPrompt({ workspacePath: "/workspace", branch: "agent/session-32" });

    for (const attempt of ["git fetch", "git ls-remote", "git push", "`gh` CLI", "curl", "WebFetch"]) {
      expect(result).toContain(attempt);
    }
  });

  it("points the agent at local git history as the only source of repo truth", () => {
    const result = formatEnvironmentForPrompt({ workspacePath: "/workspace", branch: "agent/session-32" });
    expect(result).toContain("git log");
  });

  it("says the issue is already in the prompt only when it really was resolved", () => {
    const withIssue = formatEnvironmentForPrompt({ workspacePath: "/workspace", hasIssueContext: true });
    const withoutIssue = formatEnvironmentForPrompt({ workspacePath: "/workspace", hasIssueContext: false });

    expect(withIssue).toContain("appear at the end");
    expect(withoutIssue).not.toContain("appear at the end");
    expect(withoutIssue).toContain("say so plainly");
  });

  it("says there is no checkout at all for a codebase-less session, and claims no branch", () => {
    const result = formatEnvironmentForPrompt({});

    expect(result).toContain("No repository is checked out");
    expect(result).not.toContain("/workspace");
    expect(result).not.toContain("branch");
  });

  it("still ends with a separator so the next section cannot read as part of it", () => {
    expect(formatEnvironmentForPrompt({ workspacePath: "/workspace" })).toMatch(/\n\n---\n\n$/);
  });
});

describe("hashPrompt", () => {
  it("matches a plain sha256 hex digest of the input", () => {
    expect(hashPrompt("hello")).toBe(createHash("sha256").update("hello").digest("hex"));
  });

  it("produces different hashes for different prompts", () => {
    expect(hashPrompt("a")).not.toBe(hashPrompt("b"));
  });
});
