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

const { processMemoryRetrospectiveJob } = await import("../memory-retrospective");

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    getRunsForSession: vi.fn().mockResolvedValue([{ id: 10, status: "done" as const }]),
    listEventsForSession: vi.fn().mockResolvedValue([
      { id: 1, runId: 10, seq: 1, type: "tool_call", data: { tool: "Bash", input: { command: "rm -rf /" } }, createdAt: "2026-09-17T00:00:00.000Z" },
      { id: 2, runId: 10, seq: 2, type: "error", data: { message: "permission denied" }, createdAt: "2026-09-17T00:00:01.000Z" },
    ]),
    listEvalsForRun: vi.fn().mockResolvedValue([]),
    judge: vi.fn().mockResolvedValue({
      items: [{ lesson: "Don't run destructive shell commands without confirmation.", why: "Run 10 ran rm -rf / and hit permission denied." }],
      truncated: false,
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
      judge: vi.fn().mockResolvedValue({ items: [{ lesson: "Lesson one.", why: "a" }, { lesson: "Lesson two.", why: "b" }], truncated: false }),
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
    const deps = baseDeps({ judge: vi.fn().mockResolvedValue({ items: [], truncated: false }) });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    expect(deps.writeMemoryEntry).not.toHaveBeenCalled();
  });

  it("logs the judge's reasoning when it returns zero lessons", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const deps = baseDeps({
      judge: vi.fn().mockResolvedValue({ items: [], truncated: false, reasoning: "Only task-specific setup steps happened." }),
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
      judge: vi.fn().mockResolvedValue({ items: [{ lesson: "Lesson one.", why: "w" }, { lesson: "Lesson two.", why: "w" }], truncated: false }),
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

  it("passes the session's events to the judge inside a timeline tag", async () => {
    const deps = baseDeps();

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    const [userMessage] = deps.judge.mock.calls[0];
    expect(userMessage).toContain("<known_lessons>(none)</known_lessons>");
    expect(userMessage).toContain("<timeline>");
    expect(userMessage).toContain("rm -rf /");
  });

  it("passes no reason when the judge gave no why", async () => {
    const deps = baseDeps({ judge: vi.fn().mockResolvedValue({ items: [{ lesson: "Keep me." }], truncated: false }) });

    await processMemoryRetrospectiveJob(1, 2, 3, deps as any);

    expect(deps.writeMemoryEntry).toHaveBeenCalledExactlyOnceWith(1, 2, "Keep me.", "retrospective", { runId: 10, sessionId: 3 }, { reason: undefined });
  });
});
