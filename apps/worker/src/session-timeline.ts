import { TRUNCATION_MARKER, truncateMiddle } from "./secret-masking";

export interface TimelineTask { ref: string; title: string; description: string }
export interface TimelineRun { id: number; status: string; triggeringMessageId?: number }
export interface TimelineMessage { id: number; role: "user" | "assistant"; content: string; runId?: number; kind?: "task_brief" }
export interface TimelineEvent { runId: number; seq: number; type: string; data: Record<string, unknown> }
export interface TimelineInput { task?: TimelineTask; runs: TimelineRun[]; messages: TimelineMessage[]; events: TimelineEvent[] }
export type EntryKind = "task_brief" | "user_message" | "user_excerpt" | "tool_call" | "tool_failed" | "run_error" | "note" | "agent_reply" | "omitted";
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
  return { text: renderTimeline(fitTimeline(doc)), sources, hasUserMessage, hasFailure: sources.failures.size > 0 };
}

export const TIMELINE_MAX_CHARS = 80_000;
const TASK_TEXT_CAP = 2_000;
const USER_MESSAGE_CAP = 4_000;
const FAILURE_CAP = 2_000;
const REPLY_CAP = 1_000;
const CORRECTED_REPLY_CAP = 3_000;
const USER_BUDGET = 24_000;
const FAILURE_BUDGET = 16_000;
const SHORT_USER_MESSAGE_CHARS = 40;
const ALWAYS_KEPT_USER_MESSAGES = 2;
const MIN_RUNS_KEPT = 3;
const RULE_EXCERPT_BUDGET = 4_000;
const RULE_SENTENCE_MIN_CHARS = 15;
const RULE_SENTENCE_MAX_CHARS = 400;
const RULE_WORDING =
  /\b(from now on|going forward|in (the )?future|always|never|every time|each time|whenever|by default|make sure|remember (to|that)|(do not|don't) ever|please (do not|don't|stop|avoid|keep|use|prefer)|(i|we) prefer|our (rule|convention|standard|style))\b/i;
const ACKNOWLEDGED_RULE =
  /\b(noted|understood|i'll remember|i will remember|(i'll|i will) keep (that|this|it) in mind|going forward|from now on|in future replies)\b/i;
const FAILURE_KINDS: ReadonlySet<EntryKind> = new Set(["tool_failed", "run_error"]);
const REST_KINDS: ReadonlySet<EntryKind> = new Set(["agent_reply", "tool_call", "note"]);

interface Position {
  run: number;
  index: number;
}

function positionsOf(doc: TimelineDocument, kinds: ReadonlySet<EntryKind>): Position[] {
  return doc.runs.flatMap((run, r) => run.entries.flatMap((entry, i) => (kinds.has(entry.kind) ? [{ run: r, index: i }] : [])));
}

function entryAt(doc: TimelineDocument, p: Position): TimelineEntry {
  return doc.runs[p.run].entries[p.index];
}

function omit(doc: TimelineDocument, p: Position): void {
  const entry = entryAt(doc, p);
  doc.runs[p.run].entries[p.index] = { kind: "omitted", attrs: { kind: entry.kind, count: "1" }, text: "" };
}

function capEntries(doc: TimelineDocument): void {
  if (doc.task) doc.task.text = truncateMiddle(doc.task.text, TASK_TEXT_CAP);
  doc.runs.forEach((run, r) => {
    const nextStartsWithUser = doc.runs[r + 1]?.entries[0]?.kind === "user_message";
    for (const entry of run.entries) {
      const cap =
        entry.kind === "task_brief" ? TASK_TEXT_CAP
        : entry.kind === "user_message" ? USER_MESSAGE_CAP
        : FAILURE_KINDS.has(entry.kind) ? FAILURE_CAP
        : entry.kind === "agent_reply" ? (nextStartsWithUser ? CORRECTED_REPLY_CAP : REPLY_CAP)
        : undefined;
      if (cap !== undefined) entry.text = truncateMiddle(entry.text, cap);
    }
  });
}

function collapseDuplicateFailures(doc: TimelineDocument): void {
  const firstByKey = new Map<string, TimelineEntry>();
  for (const run of doc.runs) {
    run.entries = run.entries.filter((entry) => {
      if (entry.kind !== "tool_failed") return true;
      const key = `${entry.attrs.tool}\u0000${entry.attrs.input}\u0000${entry.text}`;
      const first = firstByKey.get(key);
      if (!first) {
        firstByKey.set(key, entry);
        return true;
      }
      first.attrs.count = String(Number(first.attrs.count ?? "1") + 1);
      return false;
    });
  }
}

function keepWithinBudget(doc: TimelineDocument, ordered: Position[], budget: number, always: Position[] = []): void {
  const keep = new Set<Position>(always);
  let used = always.reduce((sum, p) => sum + renderEntryLength(entryAt(doc, p)), 0);
  for (const p of ordered) {
    const size = renderEntryLength(entryAt(doc, p));
    if (used + size > budget) continue;
    keep.add(p);
    used += size;
  }
  for (const p of [...always, ...ordered]) if (!keep.has(p)) omit(doc, p);
}

function budgetUserMessages(doc: TimelineDocument): void {
  const users = positionsOf(doc, new Set(["user_message"]));
  const always = users.slice(0, ALWAYS_KEPT_USER_MESSAGES);
  const rest = users.slice(ALWAYS_KEPT_USER_MESSAGES).reverse();
  const isShort = (p: Position) => entryAt(doc, p).text.trim().length < SHORT_USER_MESSAGE_CHARS;
  const acknowledged = (p: Position) => doc.runs[p.run].entries.some((e) => e.kind === "agent_reply" && ACKNOWLEDGED_RULE.test(e.text));
  const pinned = rest.filter(acknowledged);
  const others = rest.filter((p) => !acknowledged(p));
  keepWithinBudget(doc, [...pinned, ...others.filter((p) => !isShort(p)), ...others.filter(isShort)], USER_BUDGET, always);
}

function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

export function ruleSentences(text: string): string[] {
  return sentencesOf(text).filter(
    (sentence) =>
      sentence.length >= RULE_SENTENCE_MIN_CHARS &&
      sentence.length <= RULE_SENTENCE_MAX_CHARS &&
      RULE_WORDING.test(sentence.replace(/never mind/gi, "")),
  );
}

function isUserSlot(entry: TimelineEntry): boolean {
  return entry.kind === "user_message" || (entry.kind === "omitted" && entry.attrs.kind === "user_message");
}

function surfaceHiddenRules(doc: TimelineDocument, originals: Array<TimelineEntry | undefined>): void {
  let used = 0;
  doc.runs.forEach((run, r) => {
    const original = originals[r];
    const slot = run.entries.findIndex(isUserSlot);
    if (!original || slot === -1) return;
    const visible = run.entries[slot].kind === "user_message" ? run.entries[slot].text : "";
    const hidden = ruleSentences(original.text).filter((sentence) => !visible.includes(sentence));
    if (hidden.length === 0) return;
    const closing = sentencesOf(original.text).at(-1) ?? "";
    const context = closing.length <= RULE_SENTENCE_MAX_CHARS && !visible.includes(closing) && !hidden.includes(closing) ? [closing] : [];
    const pieces: string[] = [];
    for (const piece of [...hidden, ...context]) {
      const size = piece.length + TRUNCATION_MARKER.length;
      if (used + size > RULE_EXCERPT_BUDGET) continue;
      pieces.push(piece);
      used += size;
    }
    if (!pieces.some((piece) => hidden.includes(piece))) return;
    run.entries.splice(slot + 1, 0, { kind: "user_excerpt", attrs: { id: original.attrs.id }, text: pieces.join(TRUNCATION_MARKER) });
  });
}

function budgetNewest(doc: TimelineDocument, kinds: ReadonlySet<EntryKind>, budget: number): void {
  keepWithinBudget(doc, positionsOf(doc, kinds).reverse(), budget);
}

function restBudget(doc: TimelineDocument): number {
  const withoutRest: TimelineDocument = {
    ...doc,
    runs: doc.runs.map((run) => ({ ...run, entries: run.entries.filter((e) => !REST_KINDS.has(e.kind)) })),
  };
  return Math.max(TIMELINE_MAX_CHARS - renderTimeline(withoutRest).length, 0);
}

function mergeOmitted(doc: TimelineDocument): void {
  for (const run of doc.runs) {
    const merged: TimelineEntry[] = [];
    for (const entry of run.entries) {
      const last = merged[merged.length - 1];
      if (entry.kind === "omitted" && last?.kind === "omitted" && last.attrs.kind === entry.attrs.kind) {
        last.attrs.count = String(Number(last.attrs.count) + Number(entry.attrs.count));
      } else {
        merged.push(entry);
      }
    }
    run.entries = merged;
  }
}

function applyLimits(source: TimelineDocument): TimelineDocument {
  const doc = structuredClone(source);
  const originalUserMessages = doc.runs.map((run) => structuredClone(run.entries.find((e) => e.kind === "user_message")));
  capEntries(doc);
  collapseDuplicateFailures(doc);
  budgetUserMessages(doc);
  surfaceHiddenRules(doc, originalUserMessages);
  budgetNewest(doc, FAILURE_KINDS, FAILURE_BUDGET);
  budgetNewest(doc, REST_KINDS, restBudget(doc));
  mergeOmitted(doc);
  return doc;
}

export function fitTimeline(doc: TimelineDocument): TimelineDocument {
  let current = doc;
  let fitted = applyLimits(current);
  while (renderTimeline(fitted).length > TIMELINE_MAX_CHARS && current.runs.length > MIN_RUNS_KEPT) {
    current = { ...current, runs: [current.runs[0], ...current.runs.slice(2)], omittedRuns: current.omittedRuns + 1 };
    fitted = applyLimits(current);
  }
  return fitted;
}
