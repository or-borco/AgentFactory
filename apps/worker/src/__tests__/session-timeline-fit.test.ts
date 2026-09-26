import { describe, expect, it } from "vitest";
import { TIMELINE_MAX_CHARS, buildSessionTimeline, fitTimeline, renderTimeline, type TimelineDocument, type TimelineEntry } from "../session-timeline";
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

  it("keeps the first two user messages whole, then shrinks older long ones before dropping any", () => {
    const runs: TimelineEntry[][] = [];
    runs.push([user(1, `first correction ${"a".repeat(3_900)}`)]);
    runs.push([user(2, `second ${"b".repeat(3_900)}`)]);
    for (let i = 3; i <= 8; i++) runs.push([user(i, `message ${i} ${"c".repeat(3_900)}`)]);
    runs.push([user(9, "thanks")]);
    const fitted = fitTimeline(doc(runs));
    const users = new Map(fitted.runs.flatMap((r) => r.entries).filter((e) => e.kind === "user_message").map((e) => [e.attrs.id, e.text]));
    expect([...users.keys()].sort((a, b) => Number(a) - Number(b))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(users.get("1")!.length).toBeGreaterThan(3_900);
    expect(users.get("2")!.length).toBeGreaterThan(3_900);
    expect(users.get("8")!.length).toBeGreaterThan(3_900);
    expect(users.get("3")!.length).toBeLessThanOrEqual(2_000 + 20);
  });

  it("keeps the tail of a shrunk message, where a standing rule usually sits", () => {
    const rule = "Going forward, please use British spelling in every reply.";
    const runs: TimelineEntry[][] = [[user(1, "hi there, let's start")], [user(2, "next step please")]];
    runs.push([user(3, `${"x".repeat(5_000)}\n\n${rule}\n\nWhich note is highest?`)]);
    for (let i = 4; i <= 10; i++) runs.push([user(i, `filler ${i} ${"c".repeat(4_500)}`)]);
    const fitted = fitTimeline(doc(runs));
    const third = fitted.runs.flatMap((r) => r.entries).find((e) => e.kind === "user_message" && e.attrs.id === "3");
    expect(third?.text).toContain(rule);
  });

  it("still drops the oldest long messages, then short ones, when even shrunk ones do not fit", () => {
    const runs: TimelineEntry[][] = [];
    for (let i = 1; i <= 30; i++) runs.push([user(i, `message ${i} ${"c".repeat(3_900)}`)]);
    runs.push([user(31, "thanks")]);
    const fitted = fitTimeline(doc(runs));
    const entries = fitted.runs.flatMap((r) => r.entries);
    const kept = entries.filter((e) => e.kind === "user_message").map((e) => e.attrs.id);
    expect(kept).toEqual(expect.arrayContaining(["1", "2", "30", "31"]));
    expect(kept).not.toContain("3");
    expect(entries.some((e) => e.kind === "omitted" && e.attrs.kind === "user_message")).toBe(true);
    const userChars = entries.filter((e) => e.kind === "user_message").reduce((sum, e) => sum + e.text.length, 0);
    expect(userChars).toBeLessThanOrEqual(24_000);
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

describe("buildSessionTimeline on the judge eval fixtures", () => {
  it("keeps the British spelling rule buried in a long mid-session message", () => {
    const fixture = FIXTURES.find((f) => f.name === "rule buried in a long mid-session message")!;
    expect(buildSessionTimeline(fixture.input).text).toContain("please use British spelling");
  });

  it("keeps the early correction in a long session", () => {
    const fixture = FIXTURES.find((f) => f.name === "long session with an early correction")!;
    expect(buildSessionTimeline(fixture.input).text).toContain("not how we write release notes here");
  });
});
