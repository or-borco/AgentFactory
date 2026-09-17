import { describe, expect, it, vi } from "vitest";
import type { OutputChunk } from "../sandbox/types";
import { readAgentTurnOutput } from "../agent-runtime/marker-protocol";
import { InsufficientCreditError, PromptTooLongError } from "../agent-runtime/errors";

async function* chunks(items: OutputChunk[]): AsyncGenerator<OutputChunk> {
  for (const item of items) yield item;
}

describe("readAgentTurnOutput", () => {
  it("returns the parsed result when the output contains a result line", async () => {
    const output = chunks([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);
    await expect(readAgentTurnOutput(output)).resolves.toEqual({ text: "Hi", providerSessionRef: "ref-1" });
  });

  it("throws PromptTooLongError when the output emits the overflow marker", async () => {
    const output = chunks([{ stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "prompt_too_long" })}\n` }]);
    await expect(readAgentTurnOutput(output)).rejects.toBeInstanceOf(PromptTooLongError);
  });

  it("throws InsufficientCreditError when the output emits the insufficient_credit marker", async () => {
    const output = chunks([{ stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "insufficient_credit" })}\n` }]);
    await expect(readAgentTurnOutput(output)).rejects.toBeInstanceOf(InsufficientCreditError);
  });

  it("throws a generic error when the output produces neither marker", async () => {
    const output = chunks([{ stream: "stderr", data: "container crashed\n" }]);
    await expect(readAgentTurnOutput(output)).rejects.toThrow(/produced no result line/);
  });

  it("falls through to the generic failure when the error code isn't recognized", async () => {
    const output = chunks([{ stream: "stdout", data: `__ERROR__${JSON.stringify({ code: "some_other_failure" })}\n` }]);
    const result = readAgentTurnOutput(output);
    await expect(result).rejects.not.toBeInstanceOf(PromptTooLongError);
    await expect(result).rejects.toThrow(/produced no result line/);
  });

  it("returns successfully when the result text itself contains the __ERROR__ marker substring", async () => {
    const text = 'It emits a line like __ERROR__{"code":"prompt_too_long"}';
    const output = chunks([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text, providerSessionRef: "ref-2" })}\n` },
    ]);
    await expect(readAgentTurnOutput(output)).resolves.toEqual({ text, providerSessionRef: "ref-2" });
  });

  it("falls through to the generic failure when the __ERROR__ payload isn't valid JSON", async () => {
    const output = chunks([{ stream: "stdout", data: "__ERROR__not-json\n" }]);
    const result = readAgentTurnOutput(output);
    await expect(result).rejects.not.toBeInstanceOf(PromptTooLongError);
    await expect(result).rejects.toThrow(/produced no result line/);
  });

  it("forwards __EVENT__ lines to onEvent as they arrive", async () => {
    const onEvent = vi.fn().mockResolvedValue(undefined);
    const output = chunks([
      { stream: "stdout", data: `__EVENT__${JSON.stringify({ type: "thinking_delta", text: "thinking..." })}\n` },
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "done", providerSessionRef: "ref-3" })}\n` },
    ]);
    await readAgentTurnOutput(output, onEvent);
    expect(onEvent).toHaveBeenCalledWith({ type: "thinking_delta", text: "thinking..." });
  });

  it("forwards a memory_write event through onEvent with its content and no runId/type collision", async () => {
    const onEvent = vi.fn().mockResolvedValue(undefined);
    const output = chunks([
      {
        stream: "stdout",
        data: `__EVENT__${JSON.stringify({ type: "memory_write", content: "Don't touch migration files directly." })}\n`,
      },
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "done", providerSessionRef: "ref-5" })}\n` },
    ]);
    await readAgentTurnOutput(output, onEvent);
    expect(onEvent).toHaveBeenCalledWith({
      type: "memory_write",
      content: "Don't touch migration files directly.",
    });
  });

  it("redacts __EVENT__ line content from the no-result-line error message", async () => {
    const onEvent = vi.fn().mockResolvedValue(undefined);
    const secretLesson = "Don't touch migration files directly.";
    const output = chunks([
      {
        stream: "stdout",
        data: `__EVENT__${JSON.stringify({ type: "memory_write", content: secretLesson })}\n`,
      },
    ]);
    const result = readAgentTurnOutput(output, onEvent);
    await expect(result).rejects.toThrow(/produced no result line/);
    await expect(result).rejects.not.toThrow(new RegExp(secretLesson.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // The event is still forwarded to onEvent — only the error-message buffer redacts it.
    expect(onEvent).toHaveBeenCalledWith({ type: "memory_write", content: secretLesson });
  });

  it("ignores malformed (non-JSON) __EVENT__ lines", async () => {
    const onEvent = vi.fn().mockResolvedValue(undefined);
    const output = chunks([
      { stream: "stdout", data: "__EVENT__not-json\n" },
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "done", providerSessionRef: "ref-4" })}\n` },
    ]);
    await readAgentTurnOutput(output, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
