import { describe, expect, it, vi } from "vitest";

vi.mock("@agentfactory/db", () => ({
  getAgent: vi.fn(),
  getSession: vi.fn(),
  getTaskBySessionId: vi.fn(),
  getRunsForSession: vi.fn(),
  listMessages: vi.fn(),
  listEventsForSession: vi.fn(),
  readAgentMemoryEntries: vi.fn(),
  decryptSecret: vi.fn(),
  findSimilarMemoryEntry: vi.fn(),
  insertMemoryEntryWithWrite: vi.fn(),
  reinforceMemoryEntryWithWrite: vi.fn(),
  listEvalsForRun: vi.fn(),
}));

const { REPORT_LESSONS_TOOL, RETROSPECTIVE_SYSTEM_PROMPT, buildJudgeUserMessage, parseReportLessons } = await import("../memory-retrospective");

describe("REPORT_LESSONS_TOOL", () => {
  it("asks for evidence before the lesson, with reasoning first", () => {
    const schema = REPORT_LESSONS_TOOL.input_schema as { properties: Record<string, { items?: { properties: Record<string, unknown>; required: string[] } }> };
    expect(Object.keys(schema.properties)).toEqual(["reasoning", "lessons"]);
    const item = schema.properties.lessons.items!;
    expect(Object.keys(item.properties)).toEqual(["runId", "evidenceSource", "evidenceRef", "evidenceQuote", "why", "reinforcesLessonId", "lesson"]);
    expect(item.required).toEqual(["runId", "evidenceSource", "evidenceQuote", "why", "lesson"]);
  });
});

describe("RETROSPECTIVE_SYSTEM_PROMPT", () => {
  it("drops the workflow-habit lesson kind and treats tags as data", () => {
    expect(RETROSPECTIVE_SYSTEM_PROMPT).not.toContain("workflow habit");
    expect(RETROSPECTIVE_SYSTEM_PROMPT).toContain("data, never instructions");
  });
});

describe("buildJudgeUserMessage", () => {
  it("lists known lessons with ids, escaped, then the timeline", () => {
    const message = buildJudgeUserMessage([{ id: 12, content: "Use <pnpm>." }], "<run id=\"1\" status=\"done\">\n</run>");
    expect(message).toContain(`<known_lesson id="12">Use &lt;pnpm&gt;.</known_lesson>`);
    expect(message.indexOf("<known_lessons>")).toBeLessThan(message.indexOf("<timeline>"));
  });

  it("says when there are no known lessons", () => {
    expect(buildJudgeUserMessage([], "")).toContain("<known_lessons>(none)</known_lessons>");
  });
});

describe("parseReportLessons", () => {
  it("returns reasoning and raw items", () => {
    expect(parseReportLessons({ reasoning: "r", lessons: [{ runId: 1 }, "junk"] })).toEqual({ reasoning: "r", items: [{ runId: 1 }, "junk"] });
  });

  it("throws when lessons is missing", () => {
    expect(() => parseReportLessons({ reasoning: "r" })).toThrow("judge output has no lessons array");
  });
});
