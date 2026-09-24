export interface TimelineTask { ref: string; title: string; description: string }
export interface TimelineRun { id: number; status: string; triggeringMessageId?: number }
export interface TimelineMessage { id: number; role: "user" | "assistant"; content: string; runId?: number; kind?: "task_brief" }
export interface TimelineEvent { runId: number; seq: number; type: string; data: Record<string, unknown> }
export interface TimelineInput { task?: TimelineTask; runs: TimelineRun[]; messages: TimelineMessage[]; events: TimelineEvent[] }
export type EntryKind = "task_brief" | "user_message" | "tool_call" | "tool_failed" | "run_error" | "note" | "agent_reply" | "omitted";
export interface TimelineEntry { kind: EntryKind; attrs: Record<string, string>; text: string }
export interface TimelineRunBlock { runId: number; status: string; entries: TimelineEntry[] }
export interface TimelineDocument { task?: { attrs: Record<string, string>; text: string }; runs: TimelineRunBlock[]; omittedRuns: number }
export interface FailureSource { id: string; runId: number; seq: number; tool: string; input: string; command?: string; output: string }
export interface SuccessMarker { runId: number; seq: number; tool: string; command?: string }
export interface TimelineSources { runIds: Set<number>; userMessages: Map<number, string[]>; failures: Map<string, FailureSource>; successes: SuccessMarker[] }
export interface SessionTimeline { text: string; sources: TimelineSources; hasUserMessage: boolean; hasFailure: boolean }

const MIN_REVIEWABLE_USER_MESSAGE_CHARS = 15;
const NOTE_MAX_CHARS = 200;
const INSTALL_OK_STATUSES = new Set(["ok", "up_to_date"]);

export function escapeTimelineText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, NOTE_MAX_CHARS);
}

function renderAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeTimelineText(value)}"`)
    .join("");
}

function renderEntry(entry: TimelineEntry): string {
  if (entry.kind === "omitted") return `<omitted${renderAttrs(entry.attrs)}/>`;
  return `<${entry.kind}${renderAttrs(entry.attrs)}>${escapeTimelineText(entry.text)}</${entry.kind}>`;
}

export function renderEntryLength(entry: TimelineEntry): number {
  return renderEntry(entry).length + 1;
}

export function renderTimeline(doc: TimelineDocument): string {
  const parts: string[] = [];
  if (doc.task) parts.push(`<task${renderAttrs(doc.task.attrs)}>${escapeTimelineText(doc.task.text)}</task>`);
  doc.runs.forEach((run, index) => {
    if (index === 1 && doc.omittedRuns > 0) parts.push(`<omitted_runs count="${doc.omittedRuns}"/>`);
    const body = run.entries.map(renderEntry).join("\n");
    parts.push(`<run id="${run.runId}" status="${escapeTimelineText(run.status)}">\n${body}\n</run>`);
  });
  return parts.join("\n\n");
}

interface Counters {
  failures: number;
  errors: number;
}

function entriesForEvent(event: TimelineEvent, counters: Counters, sources: TimelineSources): TimelineEntry[] {
  const { data } = event;
  if (event.type === "thinking_delta") {
    const tool = str(data.tool);
    if (!tool) return [];
    const filePath = str(data.filePath);
    const text = str(data.description) ?? str(data.command) ?? (filePath ? `${tool}: ${filePath}` : tool);
    return [{ kind: "tool_call", attrs: { tool }, text }];
  }
  if (event.type === "tool_result") {
    const tool = str(data.tool) ?? "unknown";
    const command = str(data.command);
    if (data.isError !== true) {
      sources.successes.push({ runId: event.runId, seq: event.seq, tool, ...(command ? { command } : {}) });
      return [];
    }
    if (typeof data.output !== "string") return [];
    const id = `f${++counters.failures}`;
    const input = str(data.inputSummary) ?? tool;
    sources.failures.set(id, { id, runId: event.runId, seq: event.seq, tool, input, ...(command ? { command } : {}), output: data.output });
    const attrs: Record<string, string> = { id, tool, input };
    if (data.subagent === true) attrs.subagent = "true";
    return [{ kind: "tool_failed", attrs, text: data.output }];
  }
  if (event.type === "dependency_install") {
    const steps = Array.isArray(data.steps) ? (data.steps as Array<Record<string, unknown>>) : [];
    return steps.flatMap((step): TimelineEntry[] => {
      const status = str(step.status) ?? "failed";
      if (INSTALL_OK_STATUSES.has(status)) return [];
      const id = `f${++counters.failures}`;
      const command = str(step.command) ?? "";
      const input = `${str(step.label) ?? "step"}: ${command}`;
      const output = str(step.outputTail) ?? `(${status})`;
      sources.failures.set(id, { id, runId: event.runId, seq: event.seq, tool: "dependency_install", input, command, output });
      return [{ kind: "tool_failed", attrs: { id, tool: "dependency_install", input }, text: output }];
    });
  }
  if (event.type === "error") {
    const message = str(data.message) ?? "";
    if (data.category === "agent") return [{ kind: "run_error", attrs: { id: `e${++counters.errors}` }, text: message }];
    return [{ kind: "note", attrs: {}, text: `error: ${firstLine(message)}` }];
  }
  if (event.type === "model_escalated") {
    return [{ kind: "note", attrs: {}, text: `model escalated from ${str(data.fromModel) ?? "?"} to ${str(data.toModel) ?? "?"}` }];
  }
  if (event.type === "repo_sync") return [{ kind: "note", attrs: {}, text: `repo sync: ${str(data.status) ?? "?"}` }];
  return [];
}

export function buildTimelineDocument(input: TimelineInput): { doc: TimelineDocument; sources: TimelineSources } {
  const sources: TimelineSources = { runIds: new Set(), userMessages: new Map(), failures: new Map(), successes: [] };
  const counters: Counters = { failures: 0, errors: 0 };
  const messagesById = new Map(input.messages.map((m) => [m.id, m]));
  const eventsByRun = new Map<number, TimelineEvent[]>();
  for (const event of input.events) eventsByRun.set(event.runId, [...(eventsByRun.get(event.runId) ?? []), event]);
  let briefText: string | undefined;

  const runs = [...input.runs].sort((a, b) => a.id - b.id).map((run): TimelineRunBlock => {
    sources.runIds.add(run.id);
    const entries: TimelineEntry[] = [];
    const trigger = run.triggeringMessageId !== undefined ? messagesById.get(run.triggeringMessageId) : undefined;
    if (trigger?.role === "user") {
      if (trigger.kind === "task_brief") {
        briefText ??= trigger.content;
        entries.push({ kind: "task_brief", attrs: {}, text: trigger.content });
      } else {
        sources.userMessages.set(run.id, [...(sources.userMessages.get(run.id) ?? []), trigger.content]);
        entries.push({ kind: "user_message", attrs: { id: String(trigger.id) }, text: trigger.content });
      }
    }
    const events = [...(eventsByRun.get(run.id) ?? [])].sort((a, b) => a.seq - b.seq);
    for (const event of events) entries.push(...entriesForEvent(event, counters, sources));
    for (const reply of input.messages.filter((m) => m.role === "assistant" && m.runId === run.id)) {
      entries.push({ kind: "agent_reply", attrs: {}, text: reply.content });
    }
    return { runId: run.id, status: run.status, entries };
  });

  const description = input.task?.description.trim() ?? "";
  const taskInBrief = description !== "" && briefText !== undefined && briefText.includes(description);
  const task = input.task && !taskInBrief ? { attrs: { id: input.task.ref, title: input.task.title }, text: input.task.description } : undefined;
  return { doc: { task, runs, omittedRuns: 0 }, sources };
}

export function buildSessionTimeline(input: TimelineInput): SessionTimeline {
  const { doc, sources } = buildTimelineDocument(input);
  const hasUserMessage = [...sources.userMessages.values()].flat().some((text) => text.trim().length >= MIN_REVIEWABLE_USER_MESSAGE_CHARS);
  return { text: renderTimeline(doc), sources, hasUserMessage, hasFailure: sources.failures.size > 0 };
}
