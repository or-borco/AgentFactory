interface RunEventLike {
  runId: number;
  type: string;
  data: Record<string, unknown>;
}

// Finds the classified ErrorCode (see @agentfactory/core) for a specific run's error event, if
// any — lets a caller show a specific, safe message instead of a one-size-fits-all fallback.
// Undefined means "no classification" (an unclassified failure, or no error event at all), not
// "no error" — callers should keep their own generic fallback for that case.
export function findErrorCodeForRun(events: RunEventLike[], runId: number): string | undefined {
  const event = events.find((e) => e.type === "error" && e.runId === runId && typeof e.data.code === "string");
  return event ? (event.data.code as string) : undefined;
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

interface RunLike {
  id: number;
  status: string;
}

// A failed run's error event stays in the log forever (it's never rewritten), but once a later
// run on the same session actually succeeds, the earlier failure is history rather than a live
// problem — the caller uses this to collapse it by default instead of leaving it permanently
// shouting in the transcript.
export function isErrorResolved(sessionRuns: RunLike[], runId: number): boolean {
  return sessionRuns.some((r) => r.id > runId && r.status === "done");
}
