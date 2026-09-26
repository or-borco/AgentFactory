import { describe, expect, it } from "vitest";
import { checkLessonEvidence } from "../lesson-evidence";
import { TRUNCATION_MARKER } from "../secret-masking";
import { TIMELINE_MAX_CHARS, buildSessionTimeline, fitTimeline, renderTimeline, ruleSentences, type TimelineDocument, type TimelineEntry } from "../session-timeline";
import { FIXTURES } from "../__judge_evals__/fixtures";

const user = (id: number, text: string): TimelineEntry => ({ kind: "user_message", attrs: { id: String(id) }, text });
const reply = (text: string): TimelineEntry => ({ kind: "agent_reply", attrs: {}, text });
const failed = (id: string, text: string, input = "npm test"): TimelineEntry => ({ kind: "tool_failed", attrs: { id, tool: "Bash", input }, text });
const call = (text: string): TimelineEntry => ({ kind: "tool_call", attrs: { tool: "Bash" }, text });

function doc(runs: TimelineEntry[][]): TimelineDocument {
  return { runs: runs.map((entries, i) => ({ runId: i + 1, status: "done", entries })), omittedRuns: 0 };
}

describe("fitTimeline", () => {
  it("caps each item: user message 4,000, failure 2,000, reply 1,000", () => {
    const fitted = fitTimeline(doc([[user(1, "u".repeat(5_000)), failed("f1", "f".repeat(5_000)), reply("r".repeat(5_000))]]));
    const [u, f, r] = fitted.runs[0].entries;
    expect(u.text.length).toBeLessThanOrEqual(4_000 + 20);
    expect(f.text.length).toBeLessThanOrEqual(2_000 + 20);
    expect(r.text.length).toBeLessThanOrEqual(1_000 + 20);
  });

  it("gives a reply followed by a user message 3,000 characters", () => {
    const fitted = fitTimeline(doc([[reply("r".repeat(5_000))], [user(2, "No, do it differently please.")]]));
    const r = fitted.runs[0].entries[0];
    expect(r.text.length).toBeGreaterThan(2_900);
    expect(r.text.length).toBeLessThanOrEqual(3_000 + 20);
  });

  it("collapses identical failures into one block with a count", () => {
    const fitted = fitTimeline(doc([[failed("f1", "same error"), failed("f2", "same error")], [failed("f3", "same error")]]));
    const failures = fitted.runs.flatMap((r) => r.entries).filter((e) => e.kind === "tool_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].attrs.count).toBe("3");
    expect(failures[0].attrs.id).toBe("f1");
  });

  it("keeps the first two user messages, then longer ones newest first, dropping short ones first", () => {
    const runs: TimelineEntry[][] = [];
    runs.push([user(1, `first correction ${"a".repeat(3_900)}`)]);
    runs.push([user(2, `second ${"b".repeat(3_900)}`)]);
    for (let i = 3; i <= 9; i++) runs.push([user(i, `message ${i} ${"c".repeat(3_900)}`)]);
    runs.push([user(10, "thanks")]);
    const fitted = fitTimeline(doc(runs));
    const kept = fitted.runs.flatMap((r) => r.entries).filter((e) => e.kind === "user_message").map((e) => e.attrs.id);
    expect(kept).toContain("1");
    expect(kept).toContain("2");
    expect(kept).toContain("9");
    expect(kept).not.toContain("3");
    const omitted = fitted.runs.flatMap((r) => r.entries).filter((e) => e.kind === "omitted" && e.attrs.kind === "user_message");
    expect(omitted.length).toBeGreaterThan(0);
  });

  it("keeps the newest failures within 16,000", () => {
    const runs = Array.from({ length: 12 }, (_, i) => [failed(`f${i + 1}`, `error ${i + 1} ${"e".repeat(1_900)}`, `cmd ${i + 1}`)]);
    const fitted = fitTimeline(doc(runs));
    const ids = fitted.runs.flatMap((r) => r.entries).filter((e) => e.kind === "tool_failed").map((e) => e.attrs.id);
    expect(ids).toContain("f12");
    expect(ids).not.toContain("f1");
  });

  it("drops runs from the middle, keeping the first and the last two, when the result is still too big", () => {
    const runs = Array.from({ length: 200 }, (_, i) => [call(`step ${i} ${"x".repeat(900)}`)]);
    const fitted = fitTimeline(doc(runs));
    expect(renderTimeline(fitted).length).toBeLessThanOrEqual(TIMELINE_MAX_CHARS);
    const ids = fitted.runs.map((r) => r.runId);
    expect(ids[0]).toBe(1);
    expect(ids.slice(-2)).toEqual([199, 200]);
    expect(fitted.omittedRuns).toBeGreaterThan(0);
    expect(renderTimeline(fitted)).toContain(`<omitted_runs count="${fitted.omittedRuns}"/>`);
  });

  it("leaves a small timeline unchanged", () => {
    const small = doc([[user(1, "Please use pnpm, not npm."), reply("ok")]]);
    expect(fitTimeline(small)).toEqual(small);
  });
});

const RULE = "Going forward, please use British spelling in every reply.";
const paste = (label: string, chars: number) => `${label}: ${Array.from({ length: Math.ceil(chars / 60) }, (_, i) => `row ${i} of the pasted export with no instructions in it`).join("\n")}`;
const fillerRuns = (from: number, count: number): TimelineEntry[][] => Array.from({ length: count }, (_, i) => [user(from + i, paste(`filler ${from + i}`, 4_500)), reply("9")]);
const entriesOf = (fitted: TimelineDocument) => fitted.runs.flatMap((r) => r.entries);
const userIds = (fitted: TimelineDocument) => entriesOf(fitted).filter((e) => e.kind === "user_message").map((e) => e.attrs.id);
const excerpts = (fitted: TimelineDocument) => entriesOf(fitted).filter((e) => e.kind === "user_excerpt");

describe("fitTimeline rule salience", () => {
  it("keeps a user message whose reply acknowledges a rule ahead of newer long messages", () => {
    const runs: TimelineEntry[][] = [[user(1, "Let's start with math.js.")], [user(2, "Next step please.")]];
    runs.push([user(3, `${paste("review export", 4_000)}\n\nAlso make the output a table.`), reply("Done. Noted the preference and I'll keep it in mind for future replies.")]);
    runs.push(...fillerRuns(4, 7));
    const fitted = fitTimeline(doc(runs));
    expect(userIds(fitted)).toContain("3");
    expect(userIds(fitted)).not.toContain("4");
  });

  it("does not treat an ordinary reply as an acknowledgement", () => {
    const runs: TimelineEntry[][] = [[user(1, "Let's start.")], [user(2, "Next.")]];
    runs.push([user(3, paste("review export", 4_000)), reply("The highest line number is 90.")]);
    runs.push(...fillerRuns(4, 7));
    expect(userIds(fitTimeline(doc(runs)))).not.toContain("3");
  });

  it("surfaces a rule sentence from an omitted user message as an excerpt in the same run", () => {
    const runs: TimelineEntry[][] = [[user(1, "Let's start.")], [user(2, "Next.")]];
    runs.push([user(3, `${paste("review export", 1_500)}\n\n${RULE}\n\n${paste("more export", 3_000)}`), reply("90")]);
    runs.push(...fillerRuns(4, 7));
    const fitted = fitTimeline(doc(runs));
    expect(userIds(fitted)).not.toContain("3");
    const run3 = fitted.runs.find((r) => r.runId === 3)!;
    const excerpt = run3.entries.find((e) => e.kind === "user_excerpt");
    expect(excerpt?.attrs.id).toBe("3");
    expect(excerpt?.text).toContain(RULE);
    expect(renderTimeline(fitted)).toContain(`<user_excerpt id="3">${RULE}`);
  });

  it("adds the closing sentence of an omitted message as context, separated by the truncation marker", () => {
    const question = "Which review note mentions the highest line number?";
    const runs: TimelineEntry[][] = [[user(1, "Let's start.")], [user(2, "Next.")]];
    runs.push([user(3, `${paste("review export", 1_500)}\n\n${RULE}\n\n${paste("more export", 3_000)}\n\n${question}`), reply("90")]);
    runs.push(...fillerRuns(4, 7));
    const excerpt = excerpts(fitTimeline(doc(runs)))[0];
    expect(excerpt.text).toBe(`${RULE}${TRUNCATION_MARKER}${question}`);
  });

  it("does not read \"never mind\" as a rule", () => {
    expect(ruleSentences("Never mind the naming notes, just answer with the number.")).toEqual([]);
    expect(ruleSentences("Never mind that; from now on always reply in British English.")).toHaveLength(1);
  });

  it("surfaces a rule sentence that the per-message cap cut out of the middle of a kept message", () => {
    const fitted = fitTimeline(doc([[user(1, `${paste("head", 2_000)}\n${RULE}\n${paste("tail", 5_000)}`)]]));
    expect(fitted.runs[0].entries[0].text).not.toContain(RULE);
    expect(excerpts(fitted).map((e) => e.text)).toEqual([RULE]);
  });

  it("adds no excerpt when the rule sentence is already visible", () => {
    const small = doc([[user(1, `Please fix the bug. ${RULE}`), reply("ok")]]);
    expect(fitTimeline(small)).toEqual(small);
  });

  it("ignores sentences without rule wording", () => {
    const runs: TimelineEntry[][] = [[user(1, "Let's start.")], [user(2, "Next.")]];
    runs.push([user(3, `${paste("export", 2_000)}\nWhich note has the highest line number?\n${paste("export", 3_000)}`), reply("90")]);
    runs.push(...fillerRuns(4, 7));
    expect(excerpts(fitTimeline(doc(runs)))).toEqual([]);
  });

  it("keeps rule excerpts within their own budget, oldest first", () => {
    const runs: TimelineEntry[][] = [[user(1, "Let's start.")], [user(2, "Next.")]];
    for (let i = 3; i <= 40; i++) runs.push([user(i, `${paste("export", 4_000)}\nFrom now on, always run the linter before commit number ${i} ${"x".repeat(150)}.\n${paste("export", 2_000)}`)]);
    const fitted = fitTimeline(doc(runs));
    const surfaced = excerpts(fitted);
    expect(surfaced.length).toBeGreaterThan(0);
    expect(surfaced.reduce((sum, e) => sum + e.text.length, 0)).toBeLessThanOrEqual(4_000);
    expect(surfaced[0].attrs.id).toBe("3");
    expect(renderTimeline(fitted).length).toBeLessThanOrEqual(TIMELINE_MAX_CHARS);
  });
});

describe("buildSessionTimeline on the judge eval fixtures", () => {
  const britishRuleFixtures = FIXTURES.filter((f) => f.lessonMentions?.source === "british");

  it.each(britishRuleFixtures.map((f) => [f.name, f] as const))("shows the British spelling rule to the judge: %s", (_, fixture) => {
    const text = buildSessionTimeline(fixture.input).text;
    expect(text).toContain("please use British spelling");
    expect(text.length).toBeLessThanOrEqual(TIMELINE_MAX_CHARS);
  });

  it("covers every rule placement with a British spelling fixture", () => {
    expect(britishRuleFixtures.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the early correction in a long session", () => {
    const fixture = FIXTURES.find((f) => f.name === "long session with an early correction")!;
    expect(buildSessionTimeline(fixture.input).text).toContain("not how we write release notes here");
  });

  it("accepts a quote taken from a surfaced excerpt as user_message evidence", () => {
    const filler = (i: number) => ({ id: 10 + i, role: "user" as const, content: paste(`filler ${i}`, 4_500) });
    const timeline = buildSessionTimeline({
      runs: Array.from({ length: 11 }, (_, i) => ({ id: i + 1, status: "done", triggeringMessageId: i === 2 ? 3 : i < 2 ? i + 1 : 10 + i })),
      messages: [
        { id: 1, role: "user", content: "Let's start." },
        { id: 2, role: "user", content: "Next." },
        { id: 3, role: "user", content: `${paste("export", 1_500)}\n\n${RULE}\n\n${paste("export", 3_000)}` },
        ...Array.from({ length: 8 }, (_, i) => filler(i + 3)),
      ],
      events: [],
    });
    expect(timeline.text).toContain("<user_excerpt");
    const verdict = checkLessonEvidence(
      { runId: 3, evidenceSource: "user_message", evidenceQuote: RULE, why: "The user set a standing spelling rule.", lesson: "Use British spelling in every reply." },
      timeline.sources,
      new Map(),
      [],
    );
    expect(verdict.ok).toBe(true);
  });
});
