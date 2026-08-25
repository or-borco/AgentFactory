import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PLATFORM_PREAMBLE, composeSystemPrompt, formatEnvironmentForPrompt, hashPrompt } from "../prompt-composition";

describe("composeSystemPrompt", () => {
  it("orders platform preamble, then team context, then repo map, then agent system prompt", () => {
    const result = composeSystemPrompt(
      "## Environment\n\nCheckout is at /workspace.\n\n---\n\n",
      "## Team Context\n\nUse pnpm.\n\n---\n\n",
      "## Repo Map\n\nThis is a monorepo.",
      "You are a reviewer.",
    );

    const preambleIndex = result.indexOf(PLATFORM_PREAMBLE);
    const environmentIndex = result.indexOf("Checkout is at /workspace.");
    const teamIndex = result.indexOf("Use pnpm.");
    const repoMapIndex = result.indexOf("This is a monorepo.");
    const agentIndex = result.indexOf("You are a reviewer.");

    expect(preambleIndex).toBe(0);
    expect(environmentIndex).toBeGreaterThan(preambleIndex);
    expect(teamIndex).toBeGreaterThan(environmentIndex);
    expect(repoMapIndex).toBeGreaterThan(teamIndex);
    expect(agentIndex).toBeGreaterThan(repoMapIndex);
  });

  it("still leads with the platform preamble when every optional section is empty", () => {
    const result = composeSystemPrompt("", "", "", "You are a reviewer.");
    expect(result).toBe(PLATFORM_PREAMBLE + "You are a reviewer.");
  });

  it("omits the repo map cleanly when empty, without changing prior behavior", () => {
    const result = composeSystemPrompt("", "## Team Context\n\nUse pnpm.\n\n---\n\n", "", "You are a reviewer.");
    expect(result).toBe(PLATFORM_PREAMBLE + "## Team Context\n\nUse pnpm.\n\n---\n\n" + "You are a reviewer.");
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
