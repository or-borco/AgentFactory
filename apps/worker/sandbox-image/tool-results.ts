export const MAX_SANDBOX_TOOL_OUTPUT_CHARS = 20_000;

export interface ToolUseInfo {
  name: string;
  inputSummary: string;
  command?: string;
}

export interface ToolResultLine {
  type: "tool_result";
  toolUseId: string;
  tool: string;
  inputSummary: string;
  command?: string;
  isError: boolean;
  subagent: boolean;
  output?: string;
}

export function summarizeToolUse(name: string, input: Record<string, unknown>) {
  const description = typeof input.description === "string" ? input.description : undefined;
  const command = typeof input.command === "string" ? input.command : undefined;
  const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
  const inputSummary = description ?? command ?? (filePath ? `${name}: ${filePath}` : name);
  return { description, command, filePath, inputSummary };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

function keepTail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export function extractToolResults(message: unknown, toolUses: ReadonlyMap<string, ToolUseInfo>): ToolResultLine[] {
  if (!isRecord(message) || message.type !== "user" || message.isReplay === true) return [];
  const inner = message.message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return [];
  const subagent = message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined;
  const lines: ToolResultLine[] = [];
  for (const block of inner.content) {
    if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const use = toolUses.get(block.tool_use_id);
    const tool = use?.name ?? "unknown";
    const base: ToolResultLine = {
      type: "tool_result",
      toolUseId: block.tool_use_id,
      tool,
      inputSummary: use?.inputSummary ?? tool,
      ...(use?.command !== undefined ? { command: use.command } : {}),
      isError: block.is_error === true,
      subagent,
    };
    lines.push(base.isError ? { ...base, output: keepTail(resultText(block.content), MAX_SANDBOX_TOOL_OUTPUT_CHARS) } : base);
  }
  return lines;
}
