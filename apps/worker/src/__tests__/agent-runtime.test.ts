import { describe, expect, it, vi } from "vitest";
import type { ExecOptions, OutputChunk, SandboxProvider } from "../sandbox/types";

// Mock the database dependency before importing agent-runtime
vi.mock("@agentfactory/db", () => ({ listConnections: vi.fn() }));

import { InsufficientCreditError, PromptTooLongError, runAgentTurn } from "../agent-runtime";

function fakeSandbox(chunks: OutputChunk[]): SandboxProvider {
  return {
    create: vi.fn(),
    exec: async function* () {
      for (const chunk of chunks) yield chunk;
    },
    writeFiles: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    resetMemory: vi.fn(),
  };
}

function baseParams(sandboxProvider: SandboxProvider) {
  return {
    sandboxProvider,
    sandboxId: "sandbox-1",
    systemPrompt: "Be helpful.",
    model: { family: "anthropic" as const, id: "claude-haiku-4-5", maxTokens: 8192 },
    userText: "What model are you using?",
  };
}

describe("runAgentTurn", () => {
  it("returns the parsed result when the sandbox succeeds", async () => {
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    await expect(runAgentTurn(baseParams(sandbox))).resolves.toEqual({ text: "Hi", providerSessionRef: "ref-1" });
  });

  it("throws PromptTooLongError when the sandbox emits the overflow marker", async () => {
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "prompt_too_long" })}\n` },
    ]);

    await expect(runAgentTurn(baseParams(sandbox))).rejects.toBeInstanceOf(PromptTooLongError);
  });

  it("throws a generic error when the sandbox produces neither marker", async () => {
    const sandbox = fakeSandbox([{ stream: "stderr", data: "container crashed\n" }]);

    await expect(runAgentTurn(baseParams(sandbox))).rejects.toThrow(/produced no result line/);
  });

  it("throws InsufficientCreditError when the sandbox emits the insufficient_credit marker", async () => {
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "insufficient_credit" })}\n` },
    ]);

    await expect(runAgentTurn(baseParams(sandbox))).rejects.toBeInstanceOf(InsufficientCreditError);
  });

  it("falls through to the generic failure when the error code isn't prompt_too_long", async () => {
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "some_other_failure" })}\n` },
    ]);

    const result = runAgentTurn(baseParams(sandbox));
    await expect(result).rejects.not.toBeInstanceOf(PromptTooLongError);
    await expect(result).rejects.toThrow(/produced no result line/);
  });

  it("returns successfully when the result text itself contains the __ERROR__ marker substring", async () => {
    const text = "Here's what run-turn.ts does: it emits a line like __ERROR__{\"code\":\"prompt_too_long\"}";
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text, providerSessionRef: "ref-2" })}\n` },
    ]);

    await expect(runAgentTurn(baseParams(sandbox))).resolves.toEqual({ text, providerSessionRef: "ref-2" });
  });

  it("falls through to the generic failure when the __ERROR__ payload isn't valid JSON", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "__ERROR__not-json\n" }]);

    const result = runAgentTurn(baseParams(sandbox));
    await expect(result).rejects.not.toBeInstanceOf(PromptTooLongError);
    await expect(result).rejects.toThrow(/produced no result line/);
  });
});

describe("runAgentTurn — structured output", () => {
  it("passes OUTPUT_SCHEMA to the sandbox exec env when outputSchema is given", async () => {
    const execSpy = vi.fn(async function* (_id: string, _cmd: string[], _opts?: ExecOptions) {
      yield { stream: "stdout" as const, data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` };
    });
    const sandbox = { ...fakeSandbox([]), exec: execSpy };
    const schema = { type: "object", properties: { summary: { type: "string" } } };

    await runAgentTurn({ ...baseParams(sandbox), outputSchema: schema });

    const [, , opts] = execSpy.mock.calls[0];
    expect(JSON.parse((opts as { env: Record<string, string> }).env.OUTPUT_SCHEMA)).toEqual(schema);
  });

  it("does not set OUTPUT_SCHEMA when outputSchema is omitted", async () => {
    const execSpy = vi.fn(async function* (_id: string, _cmd: string[], _opts?: ExecOptions) {
      yield { stream: "stdout" as const, data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` };
    });
    const sandbox = { ...fakeSandbox([]), exec: execSpy };

    await runAgentTurn(baseParams(sandbox));

    const [, , opts] = execSpy.mock.calls[0];
    expect((opts as { env: Record<string, string> }).env.OUTPUT_SCHEMA).toBeUndefined();
  });

  it("returns structuredOutput when the sandbox result includes it", async () => {
    const sandbox = fakeSandbox([
      {
        stream: "stdout",
        data: `__RESULT__${JSON.stringify({
          text: "Reviewed.",
          providerSessionRef: "ref-1",
          structuredOutput: { summary: "Looks good", verdict: "comment", comments: [] },
        })}\n`,
      },
    ]);

    const result = await runAgentTurn(baseParams(sandbox));
    expect(result.structuredOutput).toEqual({ summary: "Looks good", verdict: "comment", comments: [] });
  });

  it("leaves structuredOutput undefined when the sandbox result omits it", async () => {
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    const result = await runAgentTurn(baseParams(sandbox));
    expect(result.structuredOutput).toBeUndefined();
  });
});
