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
