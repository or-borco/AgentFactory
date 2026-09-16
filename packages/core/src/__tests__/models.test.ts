import { describe, expect, it } from "vitest";
import { nextEscalationTier } from "../models";

describe("nextEscalationTier", () => {
  it("walks up the ladder from haiku to sonnet", () => {
    expect(nextEscalationTier("claude-haiku-4-5")).toBe("claude-sonnet-5");
  });

  it("walks up the ladder from sonnet to opus", () => {
    expect(nextEscalationTier("claude-sonnet-5")).toBe("claude-opus-5");
  });

  it("returns undefined at the top of the ladder", () => {
    expect(nextEscalationTier("claude-opus-5")).toBeUndefined();
  });

  it("excludes fable from the ladder", () => {
    expect(nextEscalationTier("claude-fable-5")).toBeUndefined();
  });

  it("returns undefined for an unknown model id", () => {
    expect(nextEscalationTier("not-a-real-model")).toBeUndefined();
  });
});
