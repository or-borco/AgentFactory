import { describe, expect, it } from "vitest";
import {
  MAX_SANDBOX_TOOL_OUTPUT_CHARS,
  extractToolResults,
  summarizeToolUse,
  type ToolUseInfo,
} from "../../sandbox-image/tool-results";

const uses = new Map<string, ToolUseInfo>([
  ["tu_1", { name: "Bash", inputSummary: "Run tests", command: "pnpm test" }],
  ["tu_2", { name: "Edit", inputSummary: "Edit: src/a.ts" }],
]);

function userMessage(content: unknown, extra: Record<string, unknown> = {}) {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, ...extra };
}

describe("summarizeToolUse", () => {
  it("prefers description, then command, then file path, then the tool name", () => {
    expect(summarizeToolUse("Bash", { description: "Run tests", command: "pnpm test" }).inputSummary).toBe("Run tests");
    expect(summarizeToolUse("Bash", { command: "pnpm test" }).inputSummary).toBe("pnpm test");
    expect(summarizeToolUse("Edit", { file_path: "src/a.ts" }).inputSummary).toBe("Edit: src/a.ts");
    expect(summarizeToolUse("TodoWrite", {}).inputSummary).toBe("TodoWrite");
  });
});

describe("extractToolResults", () => {
  it("emits a failure with its text output, tool name and command", () => {
    const lines = extractToolResults(
      userMessage([{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "FAIL src/a.test.ts" }]),
      uses,
    );
    expect(lines).toEqual([
      {
        type: "tool_result",
        toolUseId: "tu_1",
        tool: "Bash",
        inputSummary: "Run tests",
        command: "pnpm test",
        isError: true,
        subagent: false,
        output: "FAIL src/a.test.ts",
      },
    ]);
  });

  it("joins text blocks of array content and ignores other blocks", () => {
    const [line] = extractToolResults(
      userMessage([
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          is_error: true,
          content: [{ type: "text", text: "line 1" }, { type: "image", source: {} }, { type: "text", text: "line 2" }],
        },
      ]),
      uses,
    );
    expect(line.output).toBe("line 1\nline 2");
  });

  it("emits a success marker without output when is_error is missing", () => {
    const [line] = extractToolResults(userMessage([{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }]), uses);
    expect(line).toEqual({ type: "tool_result", toolUseId: "tu_2", tool: "Edit", inputSummary: "Edit: src/a.ts", isError: false, subagent: false });
  });

  it("keeps only the tail of very long output", () => {
    const long = `${"x".repeat(MAX_SANDBOX_TOOL_OUTPUT_CHARS)}END`;
    const [line] = extractToolResults(userMessage([{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: long }]), uses);
    expect(line.output?.length).toBe(MAX_SANDBOX_TOOL_OUTPUT_CHARS);
    expect(line.output?.endsWith("END")).toBe(true);
  });

  it("marks subagent results", () => {
    const [line] = extractToolResults(
      userMessage([{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "e" }], { parent_tool_use_id: "tu_parent" }),
      uses,
    );
    expect(line.subagent).toBe(true);
  });

  it("skips replays, string content, non-user messages and unknown shapes", () => {
    expect(extractToolResults(userMessage([{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "e" }], { isReplay: true }), uses)).toEqual([]);
    expect(extractToolResults(userMessage("plain text"), uses)).toEqual([]);
    expect(extractToolResults({ type: "assistant", message: { content: [] } }, uses)).toEqual([]);
    expect(extractToolResults(null, uses)).toEqual([]);
    expect(extractToolResults(userMessage([{ type: "tool_result", content: "no id" }]), uses)).toEqual([]);
  });

  it("names an unknown tool use 'unknown'", () => {
    const [line] = extractToolResults(userMessage([{ type: "tool_result", tool_use_id: "tu_x", is_error: true, content: "e" }]), uses);
    expect(line.tool).toBe("unknown");
    expect(line.inputSummary).toBe("unknown");
  });
});
