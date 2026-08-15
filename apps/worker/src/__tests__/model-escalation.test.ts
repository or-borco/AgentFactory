import { describe, expect, it } from "vitest";
import { resolveEscalation } from "../model-escalation";

describe("resolveEscalation", () => {
  it("walks the ladder under the fallback policy", () => {
    expect(resolveEscalation("claude-haiku-4-5", "fallback")).toBe("claude-sonnet-5");
    expect(resolveEscalation("claude-sonnet-5", "fallback")).toBe("claude-opus-5");
  });

  it("stops at the top of the ladder under the fallback policy", () => {
    expect(resolveEscalation("claude-opus-5", "fallback")).toBeUndefined();
  });

  it("never escalates a model outside the ladder, fallback or not", () => {
    expect(resolveEscalation("claude-fable-5", "fallback")).toBeUndefined();
  });

  it("never escalates under the fail_fast policy", () => {
    expect(resolveEscalation("claude-haiku-4-5", "fail_fast")).toBeUndefined();
  });
});
