import type { FailureSource, SuccessMarker, TimelineSources } from "./session-timeline";

export interface JudgedItem {
  runId: number;
  evidenceSource: "user_message" | "tool_failure";
  evidenceRef?: string;
  evidenceQuote: string;
  why: string;
  reinforcesLessonId?: number;
  lesson?: string;
}

export type EvidenceVerdict = { ok: true; item: JudgedItem } | { ok: false; reason: string; closest?: string };

export const MIN_QUOTE_CHARS = 20;
export const MAX_QUOTE_CHARS = 500;
export const MAX_LESSON_CHARS = 300;
const CLOSEST_MIN_CHARS = 10;
const SEGMENT_SKIP_WORDS = new Set(["cd", "export"]);
const PREFIX_SKIP_WORDS = new Set(["sudo", "env", "time"]);
const COMMAND_TOOLS = new Set(["Bash", "dependency_install"]);

const BLOCKLIST: RegExp[] = [
  /```/,
  /https?:\/\//i,
  /\bwww\./i,
  /\|\s*(?:sh|bash|zsh)\b/i,
  /\bcurl\b[^\n]*\|/i,
  /--no-verify\b/i,
  /--force\b/i,
  /\bforce[- ]push/i,
  /\b(?:skip|skipping|disable|disabling|bypass)\b[^.]{0,40}\b(?:hooks?|checks?|tests?|verification|ci)\b/i,
  /\[redacted\]/i,
  /[A-Za-z0-9+/_-]{24,}/,
];

export function normalizeForMatch(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
}

export function commandWord(command: string | undefined): string | undefined {
  if (!command) return undefined;
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const words = segment.trim().split(/\s+/).filter((w) => w !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    let skipSegment = false;
    for (const word of words) {
      if (SEGMENT_SKIP_WORDS.has(word)) {
        skipSegment = true;
        break;
      }
      if (PREFIX_SKIP_WORDS.has(word)) continue;
      return (word.split("/").pop() ?? word).toLowerCase();
    }
    if (skipSegment) continue;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseItem(raw: unknown, sources: TimelineSources, knownLessons: ReadonlyMap<number, string>): JudgedItem | string {
  if (!isRecord(raw)) return "not an object";
  const { runId, evidenceSource, evidenceRef, evidenceQuote, why, reinforcesLessonId, lesson } = raw;
  if (typeof runId !== "number" || !sources.runIds.has(runId)) return "unknown run";
  if (evidenceSource !== "user_message" && evidenceSource !== "tool_failure") return "bad evidence source";
  if (typeof evidenceQuote !== "string" || evidenceQuote.trim() === "") return "missing quote";
  if (typeof why !== "string" || why.trim() === "") return "missing why";
  if (reinforcesLessonId !== undefined && (typeof reinforcesLessonId !== "number" || !knownLessons.has(reinforcesLessonId))) return "unknown lesson id";
  if (reinforcesLessonId === undefined && (typeof lesson !== "string" || lesson.trim() === "")) return "missing lesson";
  if (evidenceSource === "tool_failure" && typeof evidenceRef !== "string") return "missing evidence ref";
  return {
    runId,
    evidenceSource,
    ...(typeof evidenceRef === "string" ? { evidenceRef } : {}),
    evidenceQuote,
    why,
    ...(typeof reinforcesLessonId === "number" ? { reinforcesLessonId } : {}),
    ...(typeof lesson === "string" ? { lesson } : {}),
  };
}

function quoteMatches(quote: string, text: string): boolean {
  const q = normalizeForMatch(quote);
  const t = normalizeForMatch(text);
  if (q === "") return false;
  if (t.length < MIN_QUOTE_CHARS) return q === t;
  return q.length >= MIN_QUOTE_CHARS && q.length <= MAX_QUOTE_CHARS && t.includes(q);
}

function closestMatch(quote: string, texts: string[]): string | undefined {
  const q = normalizeForMatch(quote);
  for (let length = q.length; length >= CLOSEST_MIN_CHARS; length -= 5) {
    const prefix = q.slice(0, length);
    for (const text of texts) {
      const t = normalizeForMatch(text);
      const at = t.indexOf(prefix);
      if (at >= 0) return t.slice(at, at + q.length + 20);
    }
  }
  return undefined;
}

function isAfter(success: SuccessMarker, failure: FailureSource): boolean {
  return success.runId > failure.runId || (success.runId === failure.runId && success.seq > failure.seq);
}

function recovered(failure: FailureSource, successes: SuccessMarker[]): boolean {
  const failedWord = commandWord(failure.command);
  return successes.some((s) => {
    if (!isAfter(s, failure)) return false;
    if (failure.tool === "dependency_install") return s.tool === "Bash" && failedWord !== undefined && commandWord(s.command) === failedWord;
    if (s.tool !== failure.tool) return false;
    return failure.tool !== "Bash" || (failedWord !== undefined && commandWord(s.command) === failedWord);
  });
}

function namesCommand(lessonText: string, failure: FailureSource): boolean {
  const word = COMMAND_TOOLS.has(failure.tool) ? commandWord(failure.command) : failure.tool.toLowerCase();
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(normalizeForMatch(lessonText));
}

function blocked(lessonText: string, knownSecrets: readonly string[]): string | undefined {
  if (lessonText.length > MAX_LESSON_CHARS) return "lesson too long";
  if (BLOCKLIST.some((pattern) => pattern.test(lessonText))) return "lesson blocklisted";
  if (knownSecrets.some((secret) => secret.length >= 8 && lessonText.includes(secret))) return "lesson contains a secret";
  return undefined;
}

export function checkLessonEvidence(
  raw: unknown,
  sources: TimelineSources,
  knownLessons: ReadonlyMap<number, string>,
  knownSecrets: readonly string[],
): EvidenceVerdict {
  const parsed = parseItem(raw, sources, knownLessons);
  if (typeof parsed === "string") return { ok: false, reason: parsed };
  const item = parsed;
  if (/\.\.\.|…/.test(item.evidenceQuote)) return { ok: false, reason: "quote uses an ellipsis" };

  const lessonText = item.reinforcesLessonId !== undefined ? (knownLessons.get(item.reinforcesLessonId) ?? "") : (item.lesson ?? "");
  let texts: string[];
  let failure: FailureSource | undefined;
  if (item.evidenceSource === "user_message") {
    texts = sources.userMessages.get(item.runId) ?? [];
  } else {
    failure = sources.failures.get(item.evidenceRef ?? "");
    if (!failure || failure.runId !== item.runId) return { ok: false, reason: "unknown failure" };
    texts = [`${failure.tool} ${failure.input}\n${failure.output}`];
  }
  if (!texts.some((text) => quoteMatches(item.evidenceQuote, text))) {
    return { ok: false, reason: "quote not found", closest: closestMatch(item.evidenceQuote, texts) };
  }
  if (failure) {
    if (!namesCommand(lessonText, failure)) return { ok: false, reason: "lesson not about the failing command" };
    if (!recovered(failure, sources.successes)) return { ok: false, reason: "no recovery after failure" };
  }
  if (item.lesson !== undefined) {
    const reason = blocked(item.lesson, knownSecrets);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, item };
}
