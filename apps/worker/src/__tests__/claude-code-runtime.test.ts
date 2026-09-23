import { describe, expect, it, vi } from "vitest";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";
import { claudeCodeRuntime } from "../agent-runtime/claude-code-runtime";
import { InsufficientCreditError, PromptTooLongError } from "../agent-runtime/errors";

function fakeSandbox(chunks: OutputChunk[]) {
  const execCalls: Array<{ id: string; cmd: string[]; env?: Record<string, string> }> = [];
  const sandboxProvider: SandboxProvider = {
    create: async () => ({ id: "unused" }),
    exec: (id, cmd, opts) => {
      execCalls.push({ id, cmd, env: opts?.env });
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
    writeFiles: async () => {},
    resetMemory: async () => {},
    readWorkspace: async () => ({}),
    destroy: async () => {},
    exists: async () => true,
    interrupt: async () => {},
  };
  return { sandboxProvider, execCalls };
}

function baseInput() {
  return {
    systemPrompt: "Be helpful.",
    model: { family: "anthropic" as const, id: "claude-haiku-4-5", maxTokens: 8192 },
    userText: "What model are you using?",
  };
}

describe("claudeCodeRuntime", () => {
  it("has kind 'claude-code'", () => {
    expect(claudeCodeRuntime.kind).toBe("claude-code");
  });

  it("capabilities() reports skill and resume support", () => {
    expect(claudeCodeRuntime.capabilities()).toEqual({
      supportsSkills: true,
      skillDir: ".claude/skills",
      supportsResume: true,
    });
  });

  it("execs run-turn-claude.ts and returns the parsed result", async () => {
    const { sandboxProvider, execCalls } = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    const result = await claudeCodeRuntime.runTurn(baseInput(), { sandboxProvider, sandboxId: "sandbox-1" });

    expect(result).toEqual({ text: "Hi", providerSessionRef: "ref-1" });
    expect(execCalls[0].cmd).toEqual(["/agent/node_modules/.bin/tsx", "/agent/run-turn-claude.ts"]);
    expect(execCalls[0].env?.SYSTEM_PROMPT).toBe("Be helpful.");
    expect(execCalls[0].env?.MODEL_ID).toBe("claude-haiku-4-5");
  });

  it("maps the provider-neutral model endpoint onto the Claude SDK's own env vars, never the worker's key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-platform");
    const { sandboxProvider, execCalls } = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);
    const modelEndpoint = { baseUrl: "http://host.docker.internal:8787/anthropic", token: "arata-run-abc" };

    await claudeCodeRuntime.runTurn({ ...baseInput(), modelEndpoint }, { sandboxProvider, sandboxId: "sandbox-1" });
    await claudeCodeRuntime.runTurn(baseInput(), { sandboxProvider, sandboxId: "sandbox-1" });
    vi.unstubAllEnvs();

    expect(execCalls[0].env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://host.docker.internal:8787/anthropic",
      ANTHROPIC_API_KEY: "arata-run-abc",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(execCalls[1].env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(execCalls)).not.toContain("sk-platform");
  });

  it("passes resumeSessionRef and skillNames through as env vars", async () => {
    const { sandboxProvider, execCalls } = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-2" })}\n` },
    ]);

    await claudeCodeRuntime.runTurn(
      { ...baseInput(), resumeSessionRef: "prior-ref", skillNames: ["foo", "bar"] },
      { sandboxProvider, sandboxId: "sandbox-1" },
    );

    expect(execCalls[0].env?.RESUME_SESSION_REF).toBe("prior-ref");
    expect(execCalls[0].env?.SKILL_NAMES).toBe("foo,bar");
  });

  it("sets AGENT_TURN_KIND=review when isReviewTurn is true", async () => {
    const { sandboxProvider, execCalls } = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    await claudeCodeRuntime.runTurn(
      { ...baseInput(), isReviewTurn: true },
      { sandboxProvider, sandboxId: "sandbox-1" },
    );

    expect(execCalls[0].env?.AGENT_TURN_KIND).toBe("review");
  });

  it("does not set AGENT_TURN_KIND when isReviewTurn is omitted or false", async () => {
    const { sandboxProvider, execCalls } = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    await claudeCodeRuntime.runTurn(baseInput(), { sandboxProvider, sandboxId: "sandbox-1" });

    expect(execCalls[0].env?.AGENT_TURN_KIND).toBeUndefined();
  });

  it("throws PromptTooLongError when the sandbox emits the overflow marker", async () => {
    const { sandboxProvider } = fakeSandbox([
      { stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "prompt_too_long" })}\n` },
    ]);

    await expect(
      claudeCodeRuntime.runTurn(baseInput(), { sandboxProvider, sandboxId: "sandbox-1" }),
    ).rejects.toBeInstanceOf(PromptTooLongError);
  });

  it("throws InsufficientCreditError when the sandbox emits the insufficient_credit marker", async () => {
    const { sandboxProvider } = fakeSandbox([
      { stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "insufficient_credit" })}\n` },
    ]);

    await expect(
      claudeCodeRuntime.runTurn(baseInput(), { sandboxProvider, sandboxId: "sandbox-1" }),
    ).rejects.toBeInstanceOf(InsufficientCreditError);
  });
});

describe("claudeCodeRuntime — structured output", () => {
  it("passes OUTPUT_SCHEMA to the sandbox exec env when outputSchema is given", async () => {
    const { sandboxProvider, execCalls } = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);
    const schema = { type: "object", properties: { summary: { type: "string" } } };

    await claudeCodeRuntime.runTurn(
      { ...baseInput(), outputSchema: schema },
      { sandboxProvider, sandboxId: "sandbox-1" },
    );

    expect(JSON.parse(execCalls[0].env?.OUTPUT_SCHEMA ?? "")).toEqual(schema);
  });

  it("does not set OUTPUT_SCHEMA when outputSchema is omitted", async () => {
    const { sandboxProvider, execCalls } = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    await claudeCodeRuntime.runTurn(baseInput(), { sandboxProvider, sandboxId: "sandbox-1" });

    expect(execCalls[0].env?.OUTPUT_SCHEMA).toBeUndefined();
  });

  it("returns structuredOutput when the sandbox result includes it", async () => {
    const { sandboxProvider } = fakeSandbox([
      {
        stream: "stdout",
        data: `__RESULT__${JSON.stringify({
          text: "Reviewed.",
          providerSessionRef: "ref-1",
          structuredOutput: { summary: "Looks good", verdict: "comment", comments: [] },
        })}\n`,
      },
    ]);

    const result = await claudeCodeRuntime.runTurn(baseInput(), { sandboxProvider, sandboxId: "sandbox-1" });
    expect(result.structuredOutput).toEqual({ summary: "Looks good", verdict: "comment", comments: [] });
  });

  it("leaves structuredOutput undefined when the sandbox result omits it", async () => {
    const { sandboxProvider } = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    const result = await claudeCodeRuntime.runTurn(baseInput(), { sandboxProvider, sandboxId: "sandbox-1" });
    expect(result.structuredOutput).toBeUndefined();
  });
});
