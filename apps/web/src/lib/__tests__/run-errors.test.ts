import { describe, expect, it } from "vitest";
import { findErrorCodeForRun, groupErrorsByRun, unattachedRunErrors } from "../run-errors";

describe("groupErrorsByRun", () => {
  it("groups error events by runId, ignoring other event types", () => {
    const events = [
      { runId: 1, type: "error", data: { message: "boom" } },
      { runId: 1, type: "text_delta", data: { text: "hi" } },
      { runId: 2, type: "error", data: { message: "kaboom" } },
    ];

    const byRun = groupErrorsByRun(events);

    expect(byRun.get(1)).toEqual(["boom"]);
    expect(byRun.get(2)).toEqual(["kaboom"]);
  });

  it("collects multiple error events on the same run in order", () => {
    const events = [
      { runId: 1, type: "error", data: { message: "first" } },
      { runId: 1, type: "error", data: { message: "second" } },
    ];

    expect(groupErrorsByRun(events).get(1)).toEqual(["first", "second"]);
  });

  it("falls back to a generic message when data.message isn't a string", () => {
    const events = [{ runId: 1, type: "error", data: {} }];

    expect(groupErrorsByRun(events).get(1)).toEqual(["Something went wrong."]);
  });
});

describe("unattachedRunErrors", () => {
  it("excludes runs that already have an assistant message", () => {
    const errorsByRun = new Map([
      [1, ["boom"]],
      [2, ["kaboom"]],
    ]);

    expect(unattachedRunErrors(errorsByRun, new Set([1]))).toEqual([[2, ["kaboom"]]]);
  });

  it("returns nothing when every erroring run already answered", () => {
    const errorsByRun = new Map([[1, ["boom"]]]);

    expect(unattachedRunErrors(errorsByRun, new Set([1]))).toEqual([]);
  });

  it("surfaces a run that failed before ever producing a message — the case this exists for", () => {
    const errorsByRun = new Map([[5, ["Run 5 has no session/agent to work with"]]]);

    expect(unattachedRunErrors(errorsByRun, new Set())).toEqual([[5, ["Run 5 has no session/agent to work with"]]]);
  });
});

describe("findErrorCodeForRun", () => {
  it("returns the classified code for the matching run's error event", () => {
    const events = [
      { runId: 1, type: "error", data: { message: "boom", code: "insufficient_credit" } },
      { runId: 2, type: "error", data: { message: "kaboom" } },
    ];

    expect(findErrorCodeForRun(events, 1)).toBe("insufficient_credit");
  });

  it("returns undefined when the run's error event carries no code", () => {
    const events = [{ runId: 1, type: "error", data: { message: "boom" } }];

    expect(findErrorCodeForRun(events, 1)).toBeUndefined();
  });

  it("returns undefined when the run has no error event at all", () => {
    const events = [{ runId: 1, type: "text_delta", data: { text: "hi" } }];

    expect(findErrorCodeForRun(events, 1)).toBeUndefined();
  });

  it("ignores error events belonging to a different run", () => {
    const events = [{ runId: 2, type: "error", data: { message: "boom", code: "insufficient_credit" } }];

    expect(findErrorCodeForRun(events, 1)).toBeUndefined();
  });
});
