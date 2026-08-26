import { describe, expect, it } from "vitest";
import { humanizeStep } from "../agent-response";

describe("humanizeStep — reasoning summaries", () => {
  // These events arrive only because run-turn.ts asks the SDK for thinking display:
  // "summarized". They carry `text` and no `tool`, which used to fall through to "Working".
  it("uses the first sentence of a reasoning summary as the label", () => {
    const text = "This is the classic birthday problem. The complement is easier to compute.";
    expect(humanizeStep({ text })).toBe("This is the classic birthday problem.");
  });

  it("flattens newlines so a multi-line summary stays a single-line label", () => {
    expect(humanizeStep({ text: "Checking the\n  invariant here. Then the rest." })).toBe(
      "Checking the invariant here.",
    );
  });

  it("elides a first sentence longer than the label cap", () => {
    const label = humanizeStep({ text: `${"a".repeat(200)}. Second sentence.` });
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(90);
  });

  it("handles a summary with no sentence-ending punctuation", () => {
    expect(humanizeStep({ text: "still working through the partition bounds" })).toBe(
      "still working through the partition bounds",
    );
  });

  it("still falls back to Working when there is no tool and no text", () => {
    expect(humanizeStep({})).toBe("Working");
    expect(humanizeStep({ text: "   " })).toBe("Working");
  });
});

describe("humanizeStep — tool steps are unchanged", () => {
  it("prefers the agent's own description for Bash", () => {
    expect(humanizeStep({ tool: "Bash", description: "Installing dependencies" })).toBe("Installing dependencies");
  });

  it("summarizes a bare Bash command", () => {
    expect(humanizeStep({ tool: "Bash", command: "pnpm install" })).toBe("Installing dependencies");
  });

  it("names the file for file tools", () => {
    expect(humanizeStep({ tool: "Read", filePath: "/workspace/src/strings.ts" })).toBe("Reading strings.ts");
  });

  it("parses the legacy [Tool] text shape", () => {
    expect(humanizeStep({ text: "[Bash] pnpm install" })).toBe("Installing dependencies");
    expect(humanizeStep({ text: "[Read] Read: /workspace/a/b.ts" })).toBe("Reading b.ts");
  });
});
