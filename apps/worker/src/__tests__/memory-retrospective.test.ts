import { describe, expect, it, vi } from "vitest";

// memory-retrospective.ts (directly, and transitively via memory-write.ts) imports from
// "@agentfactory/db", whose client throws at import time if DATABASE_URL isn't set, true for
// the unit project, which runs with no database. This test drives processMemoryRetrospectiveJob
// entirely through the deps seam and never touches the real db module, so a lightweight mock
// (matching the pattern already used in eval-runner.test.ts) is enough to make the module graph
// loadable here.
vi.mock("@agentfactory/db", () => ({
  getRunsForSession: vi.fn(),
  listEventsForSession: vi.fn(),
  listEvalsForRun: vi.fn(),
  findSimilarMemoryEntry: vi.fn(),
  insertMemoryEntryWithWrite: vi.fn(),
  reinforceMemoryEntryWithWrite: vi.fn(),
}));

const { parseReportLessons, processMemoryRetrospectiveJob } = await import("../memory-retrospective");

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    getRunsForSession: vi.fn().mockResolvedValue([{ id: 10, status: "done" as const }]),
    listEventsForSession: vi.fn().mockResolvedValue([
      { id: 1, runId: 10, seq: 1, type: "tool_call", data: { tool: "Bash", input: { command: "rm -rf /" } }, createdAt: "2026-09-17T00:00:00.000Z" },
      { id: 2, runId: 10, seq: 2, type: "error", data: { message: "permission denied" }, createdAt: "2026-09-17T00:00:01.000Z" },
    ]),
    listEvalsForRun: vi.fn().mockResolvedValue([]),
    judge: vi.fn().mockResolvedValue({
      lessons: [{ lesson: "Don't run destructive shell commands without confirmation.", why: "Run 10 ran rm -rf / and hit permission denied." }],
    }),
    writeMemoryEntry: vi.fn().mockResolvedValue({ reinforced: false }),
    ...overrides,
  };
}

describe("processMemoryRetrospectiveJob", () => {
  it("calls writeMemoryEntry once per lesson the judge returns", async () => {
    const deps = baseDeps();

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    expect(deps.writeMemoryEntry).toHaveBeenCalledExactlyOnceWith(
      1,
      2,
      "Don't run destructive shell commands without confirmation.",
      "retrospective",
      { runId: 10, sessionId: 3 },
      { reason: "Run 10 ran rm -rf / and hit permission denied." },
    );
  });

  it("calls writeMemoryEntry once per lesson when the judge returns multiple", async () => {
    const deps = baseDeps({
      judge: vi.fn().mockResolvedValue({ lessons: [{ lesson: "Lesson one.", why: "a" }, { lesson: "Lesson two.", why: "b" }] }),
    });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    expect(deps.writeMemoryEntry).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the session has no runs", async () => {
    const deps = baseDeps({ getRunsForSession: vi.fn().mockResolvedValue([]) });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    expect(deps.judge).not.toHaveBeenCalled();
    expect(deps.writeMemoryEntry).not.toHaveBeenCalled();
  });

  it("does nothing when the judge returns zero lessons", async () => {
    const deps = baseDeps({ judge: vi.fn().mockResolvedValue({ lessons: [] }) });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    expect(deps.writeMemoryEntry).not.toHaveBeenCalled();
  });

  it("logs the judge's reasoning when it returns zero lessons", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const deps = baseDeps({
      judge: vi.fn().mockResolvedValue({ lessons: [], reasoning: "Only task-specific setup steps happened." }),
    });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    const output = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    stdoutSpy.mockRestore();
    expect(output).toContain("Judge returned no lessons");
    expect(output).toContain("Only task-specific setup steps happened.");
  });

  it("never throws when the judge call fails (fire-and-forget, matches repo-map-warm's .catch(log.error) style)", async () => {
    const deps = baseDeps({ judge: vi.fn().mockRejectedValue(new Error("judge unavailable")) });

    await expect(processMemoryRetrospectiveJob(1, 2, 3, deps as any)).resolves.toBeUndefined();
    expect(deps.writeMemoryEntry).not.toHaveBeenCalled();
  });

  it("never throws when a writeMemoryEntry call fails partway through", async () => {
    const deps = baseDeps({
      judge: vi.fn().mockResolvedValue({ lessons: [{ lesson: "Lesson one.", why: "w" }, { lesson: "Lesson two.", why: "w" }] }),
      writeMemoryEntry: vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({ reinforced: false }),
    });

    await expect(processMemoryRetrospectiveJob(1, 2, 3, deps as any)).resolves.toBeUndefined();
  });

  it("uses the most recent run's id as provenance when the session has more than one run", async () => {
    const deps = baseDeps({
      getRunsForSession: vi.fn().mockResolvedValue([
        { id: 10, status: "failed" as const },
        { id: 11, status: "done" as const },
      ]),
    });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    expect(deps.writeMemoryEntry).toHaveBeenCalledWith(
      1,
      2,
      expect.any(String),
      "retrospective",
      { runId: 11, sessionId: 3 },
      { reason: expect.any(String) },
    );
  });

  // Regression test: the live pipeline never emits a "tool_call" event (run-turn-claude.ts
  // reports tool invocations as "thinking_delta" events carrying a `tool` field instead — see
  // its tool_use handling). summarizeEvents used to filter on the stale "tool_call" type, so the
  // judge always received an empty transcript for real sessions. Assert on what the judge
  // actually receives, not just its (mocked) output, since that's the only way to catch this.
  it("includes thinking_delta events that carry a tool field in the transcript given to the judge", async () => {
    const deps = baseDeps({
      listEventsForSession: vi.fn().mockResolvedValue([
        {
          id: 1,
          runId: 10,
          seq: 1,
          type: "thinking_delta",
          data: { type: "thinking_delta", tool: "Bash", command: "rm -rf /", text: "[Bash] rm -rf /\n" },
          createdAt: "2026-09-17T00:00:00.000Z",
        },
        {
          id: 2,
          runId: 10,
          seq: 2,
          type: "thinking_delta",
          data: { type: "thinking_delta", text: "I'm going to clean up the workspace now.\n" },
          createdAt: "2026-09-17T00:00:01.000Z",
        },
        {
          id: 3,
          runId: 10,
          seq: 3,
          type: "error",
          data: { message: "permission denied" },
          createdAt: "2026-09-17T00:00:02.000Z",
        },
      ]),
    });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    const [transcriptSummary] = deps.judge.mock.calls[0];
    expect(transcriptSummary).toContain("Bash");
    expect(transcriptSummary).toContain("rm -rf /");
    expect(transcriptSummary).toContain("permission denied");
    // Plain reasoning (no `tool` field) is noise the judge doesn't need and would otherwise
    // crowd out the budget — only tool-carrying thinking_delta events are "tool calls".
    expect(transcriptSummary).not.toContain("clean up the workspace");
  });

  it("passes no reason when the judge gave no why", async () => {
    const deps = baseDeps({ judge: vi.fn().mockResolvedValue({ lessons: [{ lesson: "Keep me." }] }) });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    expect(deps.writeMemoryEntry).toHaveBeenCalledExactlyOnceWith(1, 2, "Keep me.", "retrospective", { runId: 10, sessionId: 3 }, { reason: undefined });
  });
});

describe("parseReportLessons", () => {
  it("keeps each lesson with its why", () => {
    expect(
      parseReportLessons({
        reasoning: "Two corrections.",
        lessons: [
          { lesson: "Use pnpm.", why: "npm was corrected twice." },
          { lesson: "Validate numbers.", why: "A NaN slipped through." },
        ],
      }),
    ).toEqual({
      reasoning: "Two corrections.",
      lessons: [
        { lesson: "Use pnpm.", why: "npm was corrected twice." },
        { lesson: "Validate numbers.", why: "A NaN slipped through." },
      ],
    });
  });

  it("drops items with an empty or missing lesson", () => {
    const { lessons } = parseReportLessons({
      reasoning: "r",
      lessons: [{ lesson: "  ", why: "w" }, { why: "w" }, "a bare string", null, { lesson: "Keep me.", why: "w" }],
    });

    expect(lessons).toEqual([{ lesson: "Keep me.", why: "w" }]);
  });

  it("keeps a lesson whose why is empty, with no why", () => {
    const { lessons } = parseReportLessons({ reasoning: "r", lessons: [{ lesson: "Keep me.", why: " " }, { lesson: "Me too." }] });

    expect(lessons).toEqual([{ lesson: "Keep me." }, { lesson: "Me too." }]);
  });

  it("throws when there is no lessons array", () => {
    expect(() => parseReportLessons({ reasoning: "r" })).toThrow("judge output has no lessons array");
  });
});
