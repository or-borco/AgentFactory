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

const { REPORT_LESSONS_TOOL, RETROSPECTIVE_SYSTEM_PROMPT, buildJudgeUserMessage, describeShape, judgeRetrospective, parseReportLessons } = await import("../memory-retrospective");

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

  it("names the shape it got, without any of the values", () => {
    expect(() => parseReportLessons({ reasoning: "secret reasoning", lessons: "[{...}]" })).toThrow("(got {reasoning:string,lessons:string})");
  });
});

describe("describeShape", () => {
  it("lists keys with value types for objects and a type name otherwise", () => {
    expect(describeShape({ a: [], b: null, c: 1 })).toBe("a:array,b:null,c:number");
    expect(describeShape("text")).toBe("string");
    expect(describeShape([1])).toBe("array");
    expect(describeShape(undefined)).toBe("undefined");
  });
});

function judgeResponse(input: unknown, stop_reason = "tool_use") {
  return { stop_reason, content: [{ type: "tool_use", id: "t", name: "report_lessons", input }] } as never;
}

describe("judgeRetrospective", () => {
  it("asks again once when the first answer has no lessons array", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(judgeResponse({ reasoning: "r", lessons: "not an array" }))
      .mockResolvedValueOnce(judgeResponse({ reasoning: "r", lessons: [{ runId: 1 }] }));
    await expect(judgeRetrospective("timeline", create)).resolves.toEqual({ reasoning: "r", items: [{ runId: 1 }], truncated: false });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("asks again once when the answer has no tool call", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] } as never)
      .mockResolvedValueOnce(judgeResponse({ lessons: [] }));
    await expect(judgeRetrospective("timeline", create)).resolves.toEqual({ items: [], truncated: false });
  });

  it("gives up after the second malformed answer", async () => {
    const create = vi.fn().mockResolvedValue(judgeResponse({ reasoning: "r", lessons: "not an array" }));
    await expect(judgeRetrospective("timeline", create)).rejects.toThrow("judge output has no lessons array (got {reasoning:string,lessons:string})");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("treats two answers with reasoning and no lessons field as no lessons", async () => {
    const create = vi.fn().mockResolvedValue(judgeResponse({ reasoning: "Nothing durable here." }));
    await expect(judgeRetrospective("timeline", create)).resolves.toEqual({ reasoning: "Nothing durable here.", items: [], truncated: false });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("still uses the lessons from a second answer after a reasoning-only first answer", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(judgeResponse({ reasoning: "r" }))
      .mockResolvedValueOnce(judgeResponse({ reasoning: "r", lessons: [{ runId: 1 }] }));
    await expect(judgeRetrospective("timeline", create)).resolves.toEqual({ reasoning: "r", items: [{ runId: 1 }], truncated: false });
  });

  it("does not ask again when the answer hit max_tokens", async () => {
    const create = vi.fn().mockResolvedValue(judgeResponse({}, "max_tokens"));
    await expect(judgeRetrospective("timeline", create)).resolves.toEqual({ items: [], truncated: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
