import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL_ID } from "@agentfactory/core";
import { getRunsForSession, listEventsForSession, listEvalsForRun } from "@agentfactory/db";
import { createLogger } from "@agentfactory/logger";
import { writeMemoryEntry as writeMemoryEntryDefault } from "./memory-write";

const log = createLogger("memory-retrospective");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Same shape as eval-judge.ts's MAX_ARTEFACT_CHARS: a size cap on whatever transcript summary
// goes into the judge prompt, not a live constraint, generous enough that a truncated lesson
// pass beats a clean failure on a long session.
const MAX_TRANSCRIPT_CHARS = 40_000;
const RETROSPECTIVE_MAX_TOKENS = 2_048;

const RETROSPECTIVE_SYSTEM_PROMPT = [
  "You are reviewing a completed agent session to extract general lessons for that same agent's",
  "future sessions. You are given a summary of the session's tool calls, errors, and",
  "model escalations, plus any compliance-eval results already recorded for it.",
  "",
  "Extract 0 to 3 concise, general lessons, things worth remembering across unrelated future",
  "tasks: a recurring failure mode, a correction, a workflow habit that worked well. Explicitly",
  "exclude anything specific to this one task's business logic (a particular file, a particular",
  "feature), a lesson must generalize, or it isn't worth remembering. If nothing in the session",
  "rises to that bar, return zero lessons; that is a normal, expected outcome, not a failure.",
  "",
  "Report exclusively through the report_lessons tool.",
].join("\n");

const REPORT_LESSONS_TOOL: Anthropic.Tool = {
  name: "report_lessons",
  description: "Report the general lessons extracted from this session, if any.",
  input_schema: {
    type: "object",
    required: ["reasoning", "lessons"],
    properties: {
      reasoning: {
        type: "string",
        description: "One or two sentences explaining why these lessons, or why none, were chosen.",
      },
      lessons: {
        type: "array",
        description: "0 to 3 concise, general lessons. An empty array is a valid, expected result.",
        items: { type: "string" },
      },
    },
  },
};

interface SessionEventRow {
  runId: number;
  type: string;
  data: Record<string, unknown>;
}

// "tool_call" is a RunEvent type in @agentfactory/core but the current pipeline never persists
// one — run-turn-claude.ts reports tool invocations as "thinking_delta" events carrying a `tool`
// field instead (see its tool_use handling). Filtering here on a `tool` field, not the event
// type, is what actually captures them; a plain thinking_delta (reasoning prose, no `tool`
// field) is noise the judge doesn't need.
function summarizeEvents(events: SessionEventRow[]): string {
  const interesting = events.filter((e) => {
    if (e.type === "thinking_delta") return typeof e.data.tool === "string";
    return ["error", "model_escalated", "repo_sync"].includes(e.type);
  });
  const lines = interesting.map((e) => `[run ${e.runId}] ${e.type}: ${JSON.stringify(e.data)}`);
  const joined = lines.join("\n");
  return joined.length > MAX_TRANSCRIPT_CHARS
    ? `${joined.slice(0, MAX_TRANSCRIPT_CHARS)}\n...[transcript truncated]`
    : joined;
}

interface JudgeVerdict {
  lessons: string[];
  reasoning?: string;
}

export interface RetrospectiveDeps {
  getRunsForSession: (sessionId: number) => Promise<Array<{ id: number; status: string }>>;
  listEventsForSession: (sessionId: number) => Promise<SessionEventRow[]>;
  listEvalsForRun: (runId: number, orgId: number) => Promise<Array<{ result?: { score: number } }>>;
  judge: (transcriptSummary: string, evalSummary: string) => Promise<JudgeVerdict>;
  writeMemoryEntry: typeof writeMemoryEntryDefault;
}

async function judgeRetrospective(transcriptSummary: string, evalSummary: string): Promise<JudgeVerdict> {
  const userMessage =
    `Session transcript summary:\n\n${transcriptSummary || "(no notable events)"}\n\n` +
    `Recorded eval results for this session's runs:\n\n${evalSummary || "(none)"}`;
  const response = await client.messages.create({
    model: DEFAULT_MODEL_ID,
    max_tokens: RETROSPECTIVE_MAX_TOKENS,
    system: RETROSPECTIVE_SYSTEM_PROMPT,
    tools: [REPORT_LESSONS_TOOL],
    tool_choice: { type: "tool", name: "report_lessons" },
    messages: [{ role: "user", content: userMessage }],
  });
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("judge returned no report_lessons tool call");
  const { lessons, reasoning } = toolUse.input as { lessons?: unknown; reasoning?: unknown };
  if (!Array.isArray(lessons)) throw new Error("judge output has no lessons array");
  return {
    lessons: lessons.filter((l): l is string => typeof l === "string" && l.trim() !== ""),
    reasoning: typeof reasoning === "string" ? reasoning : undefined,
  };
}

const defaultDeps: RetrospectiveDeps = {
  getRunsForSession,
  listEventsForSession,
  listEvalsForRun,
  judge: judgeRetrospective,
  writeMemoryEntry: writeMemoryEntryDefault,
};

// Picks the run with the highest id (auto-increment PK, so the highest id is always the most
// recently created row) rather than relying on the array's order: getRunsForSession returns
// newest-first while this function's own deps interface makes no such promise, so the two must
// not be allowed to silently drift.
function mostRecentRun<T extends { id: number }>(runs: T[]): T {
  return runs.reduce((latest, run) => (run.id > latest.id ? run : latest), runs[0]);
}

// Never rejects, exactly like processEvalJob and ingestTeamContextItem: this is fire-and-forget
// from the tasks route (see apps/web's PATCH handler), and unlike run execution, safely retriable
// by BullMQ on transient failure, but the function itself still must not throw out of a caller's
// .catch(log.error) in a way that fails the task status update it rides alongside.
export async function processMemoryRetrospectiveJob(
  orgId: number,
  agentId: number,
  sessionId: number,
  deps: Partial<RetrospectiveDeps> = {},
): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  try {
    const runs = await d.getRunsForSession(sessionId);
    if (runs.length === 0) {
      log.info("No runs for session; nothing to review", { sessionId });
      return;
    }
    const lastRun = mostRecentRun(runs);

    const events = await d.listEventsForSession(sessionId);
    const transcriptSummary = summarizeEvents(events);

    const evalSummaries = await Promise.all(
      runs.map(async (run) => {
        const evals = await d.listEvalsForRun(run.id, orgId);
        return evals
          .filter((e) => e.result)
          .map((e) => `run ${run.id}: score ${e.result?.score}`)
          .join("\n");
      }),
    );
    const evalSummary = evalSummaries.filter(Boolean).join("\n");

    const { lessons, reasoning } = await d.judge(transcriptSummary, evalSummary);
    if (lessons.length === 0) {
      log.info("Judge returned no lessons", { sessionId, reasoning });
      return;
    }

    for (const lesson of lessons) {
      try {
        await d.writeMemoryEntry(orgId, agentId, lesson, "retrospective", { runId: lastRun.id, sessionId });
      } catch (err) {
        log.error("Failed to write one retrospective lesson; continuing with the rest", { sessionId, err });
      }
    }
  } catch (err) {
    log.error("Memory retrospective job failed", { orgId, agentId, sessionId, err });
  }
}
