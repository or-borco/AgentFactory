import type { Task } from "@agentfactory/core";

export function formatTaskBrief(task: Task): string {
  const lines: string[] = [task.description];

  if (task.acceptanceCriteria.length > 0) {
    lines.push("", "Acceptance criteria:");
    for (const c of task.acceptanceCriteria) {
      lines.push(`- ${c.text}`);
    }
  }

  if (task.area) lines.push("", `Code area: ${task.area}`);
  if (task.codebase) lines.push(`Codebase: ${task.codebase}`);

  return lines.join("\n");
}
