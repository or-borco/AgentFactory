interface RunEventLike {
  runId: number;
  type: string;
  data: Record<string, unknown>;
}

// Groups "error" RunEvents by runId, defaulting to a generic message when the event
// carries no usable text.
export function groupErrorsByRun(events: RunEventLike[]): Map<number, string[]> {
  const byRun = new Map<number, string[]>();
  for (const event of events) {
    if (event.type !== "error") continue;
    const message = typeof event.data.message === "string" ? event.data.message : "Something went wrong.";
    const messages = byRun.get(event.runId) ?? [];
    messages.push(message);
    byRun.set(event.runId, messages);
  }
  return byRun;
}

// Errors on runs that never produced an assistant message — e.g. a run that failed via the
// worker's top-level catch before createMessage ran. Those have nowhere to attach in the
// normal per-message render path, so the caller renders them separately.
export function unattachedRunErrors(
  errorsByRun: Map<number, string[]>,
  answeredRunIds: Set<number | undefined>,
): [number, string[]][] {
  return [...errorsByRun.entries()].filter(([runId]) => !answeredRunIds.has(runId));
}
