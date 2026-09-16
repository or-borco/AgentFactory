import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeKind } from "@agentfactory/core";
import { claudeCodeRuntime } from "../agent-runtime/claude-code-runtime";
import { getAgentRuntime, runtimes } from "../agent-runtime/registry";
import type { AgentRuntime } from "../agent-runtime/types";

afterEach(() => {
  runtimes.length = 1; // drop any stub runtime a test registered, keep claudeCodeRuntime
});

// RuntimeKind has exactly one real member ("claude-code") until a second adapter (e.g. Codex)
// ships — the cast below fabricates a second kind purely so this test can exercise dispatch
// across more than one registered runtime, mirroring packages/scm/src/__tests__/registry.test.ts's
// stub-second-provider pattern.
function stubRuntime(kind: string): AgentRuntime {
  return {
    kind: kind as unknown as RuntimeKind,
    capabilities: () => ({ supportsSkills: false, supportsResume: false }),
    runTurn: async () => ({ text: "", providerSessionRef: "" }),
  };
}

describe("getAgentRuntime", () => {
  it("returns the registered runtime for a known kind", () => {
    expect(getAgentRuntime("claude-code")).toBe(claudeCodeRuntime);
  });

  it("dispatches to the correct runtime when more than one is registered", () => {
    const stub = stubRuntime("stub-runtime");
    runtimes.push(stub);

    expect(getAgentRuntime("claude-code")).toBe(claudeCodeRuntime);
    expect(getAgentRuntime("stub-runtime" as RuntimeKind)).toBe(stub);
  });

  it("throws for a kind with no registered runtime", () => {
    expect(() => getAgentRuntime("nonexistent" as RuntimeKind)).toThrow(/No AgentRuntime registered/);
  });
});
