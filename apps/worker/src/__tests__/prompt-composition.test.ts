import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PLATFORM_PREAMBLE, composeSystemPrompt, hashPrompt } from "../prompt-composition";

describe("composeSystemPrompt", () => {
  it("orders platform preamble, then team context, then agent system prompt", () => {
    const result = composeSystemPrompt("## Team Context\n\nUse pnpm.\n\n---\n\n", "You are a reviewer.");

    const preambleIndex = result.indexOf(PLATFORM_PREAMBLE);
    const teamIndex = result.indexOf("Use pnpm.");
    const agentIndex = result.indexOf("You are a reviewer.");

    expect(preambleIndex).toBe(0);
    expect(teamIndex).toBeGreaterThan(preambleIndex);
    expect(agentIndex).toBeGreaterThan(teamIndex);
  });

  it("still leads with the platform preamble when there is no team context", () => {
    const result = composeSystemPrompt("", "You are a reviewer.");
    expect(result).toBe(PLATFORM_PREAMBLE + "You are a reviewer.");
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
