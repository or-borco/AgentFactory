// A single humanized thinking step: a friendly label plus the raw detail (shown on hover).
export interface ThinkStep {
  label: string;
  detail: string;
}

// Turn a raw shell command into a short, friendly progress phrase.
export function summarizeCommand(command: string): string {
  const c = command.trim().toLowerCase();
  if (!c) return "Running a command";
  if (/\bgit\s+(pull|fetch|clone)\b/.test(c)) return "Getting latest updates";
  if (/\bgit\s+(add|commit)\b/.test(c)) return "Saving changes";
  if (/\bgit\s+push\b/.test(c)) return "Pushing changes";
  if (/\bgit\s+(status|diff|log|branch)\b/.test(c)) return "Checking source control";
  if (/\b(npm|pnpm|yarn)\s+(install|ci|add)\b/.test(c) || /\binstall\b/.test(c)) return "Installing dependencies";
  if (/\btsc\b|type-?check/.test(c)) return "Checking types";
  if (/\b(npm|pnpm|yarn)\s+run\s+build\b|(?:^|\s)build(?:$|\s)/.test(c)) return "Building the project";
  if (/\bnode\s+(-e|--eval)\b|\bpython3?\s+-c\b/.test(c)) return "Running a quick check";
  if (/\b(test|jest|vitest|pytest)\b/.test(c)) return "Running tests";
  if (/\b(lint|eslint|prettier)\b/.test(c)) return "Checking code style";
  if (/\b(find|ls|pwd|cat|head|tail|grep|rg|tree|which|stat)\b/.test(c)) return "Exploring the codebase";
  if (/\b(mkdir|cp|mv|rm|touch|chmod)\b/.test(c)) return "Organizing files";
  if (/\becho\b/.test(c)) return "Checking output";
  return "Running a command";
}

// Longest label we'll show in the step list before eliding — ThinkStep.detail still carries
// the untruncated text for the hover tooltip, so nothing is lost.
const MAX_LABEL_LENGTH = 90;

// First sentence of a reasoning summary, flattened to one line and elided if long. Used as the
// step label so the list stays scannable when a step's text is a paragraph rather than a phrase.
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > MAX_LABEL_LENGTH ? `${sentence.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…` : sentence;
}

// Convert a thinking_delta event into a friendly phrase. Prefers the agent's own
// tool `description` when it wrote one; otherwise infers intent from the tool + command.
// Falls back to parsing the legacy `[Tool] text` string for events stored before the
// structured fields existed.
export function humanizeStep(data: Record<string, unknown>): string {
  let tool = typeof data.tool === "string" ? data.tool : "";
  let description = typeof data.description === "string" ? data.description : "";
  let command = typeof data.command === "string" ? data.command : "";
  let filePath = typeof data.filePath === "string" ? data.filePath : "";

  // Legacy events only carry `text` like "[Bash] <description-or-command>".
  if (!tool && typeof data.text === "string") {
    const m = data.text.match(/^\[(\w+)\]\s*([\s\S]*)$/);
    if (m) {
      tool = m[1];
      const rest = m[2].trim();
      const pathMatch = rest.match(/^\w+:\s*(.+)$/);
      if (pathMatch && ["Read", "Write", "Edit", "MultiEdit"].includes(tool)) filePath = pathMatch[1];
      else if (tool === "Bash") command = rest;
      else description = rest;
    }
  }

  // A reasoning summary carries no tool and doesn't match the legacy `[Tool] …` shape — the
  // agent's own words are a far better label than any phrase we could infer, so use them
  // directly. Without this branch these events fall through to the "Working" default below,
  // which is what every reasoning step rendered as before the sandbox asked the SDK for
  // thinking display: "summarized".
  if (!tool && typeof data.text === "string" && data.text.trim()) {
    return firstSentence(data.text);
  }

  const file = filePath ? filePath.split("/").pop() ?? filePath : "";
  switch (tool) {
    case "Read": return file ? `Reading ${file}` : "Reading a file";
    case "Write": return file ? `Writing ${file}` : "Writing a file";
    case "Edit":
    case "MultiEdit": return file ? `Editing ${file}` : "Editing a file";
    case "NotebookEdit": return file ? `Editing ${file}` : "Editing a notebook";
    case "Glob":
    case "Grep": return "Searching the codebase";
    case "WebSearch": return "Searching the web";
    case "WebFetch": return "Reading a web page";
    case "TodoWrite": return "Planning the work";
    case "Task": return "Delegating to a subagent";
    case "Bash": return description || summarizeCommand(command);
    default: return description || (tool ? `Using ${tool}` : "Working");
  }
}
