import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { describe, expect, it, vi } from "vitest";

config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
config({ path: fileURLToPath(new URL("../../.env.local", import.meta.url)), override: true });

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
}));

const { buildJudgeUserMessage, judgeRetrospective } = await import("../memory-retrospective");
const { buildSessionTimeline } = await import("../session-timeline");
const { checkLessonEvidence } = await import("../lesson-evidence");
const { FIXTURES } = await import("./fixtures");

const RUNS_PER_FIXTURE = Number(process.env.JUDGE_EVAL_RUNS ?? 3);
const stats = { expectedAccepted: 0, rejectedWhenExpected: 0 };

async function runOnce(fixture: (typeof FIXTURES)[number]): Promise<boolean> {
  const timeline = buildSessionTimeline(fixture.input);
  const known = new Map(fixture.known.map((k) => [k.id, k.content]));
  const result = await judgeRetrospective(buildJudgeUserMessage(fixture.known, timeline.text));
  const verdicts = result.items.map((raw) => checkLessonEvidence(raw, timeline.sources, known, []));
  const accepted = verdicts.flatMap((v) => (v.ok ? [v.item] : []));
  const rejected = verdicts.filter((v) => !v.ok);
  if (fixture.expect.kind !== "none" && !fixture.knownGap) {
    stats.expectedAccepted += verdicts.length;
    stats.rejectedWhenExpected += rejected.length;
  }
  if (rejected.length) console.log(fixture.name, "rejections:", rejected);
  if (fixture.expect.kind === "none") return accepted.length === 0;
  if (fixture.expect.kind === "reinforce") {
    const lessonId = fixture.expect.lessonId;
    return accepted.length === 1 && accepted[0].reinforcesLessonId === lessonId;
  }
  const mentions = fixture.lessonMentions;
  if (mentions && !accepted.every((a) => mentions.test(a.lesson ?? ""))) return false;
  const sources = accepted.map((a) => a.evidenceSource).sort();
  return accepted.length === fixture.expect.count && JSON.stringify(sources) === JSON.stringify([...fixture.expect.sources].sort());
}

describe.skipIf(!process.env.RUN_JUDGE_EVALS)("memory judge live evals", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      let passes = 0;
      for (let i = 0; i < RUNS_PER_FIXTURE; i++) if (await runOnce(fixture)) passes++;
      if (fixture.knownGap) {
        console.log(`Known gap "${fixture.name}": ${passes}/${RUNS_PER_FIXTURE} passed`);
        return;
      }
      const needed = fixture.expect.kind === "none" ? RUNS_PER_FIXTURE : Math.ceil((RUNS_PER_FIXTURE * 2) / 3);
      expect(passes, `${fixture.name}: ${passes}/${RUNS_PER_FIXTURE} passed`).toBeGreaterThanOrEqual(needed);
    });
  }

  it("reports the evidence-check rejection rate on positive fixtures", () => {
    const rate = stats.expectedAccepted ? stats.rejectedWhenExpected / stats.expectedAccepted : 0;
    console.log(`Evidence-check rejection rate on positive fixtures: ${(rate * 100).toFixed(1)}%`);
    expect(rate).toBeLessThanOrEqual(0.1);
  });
});
