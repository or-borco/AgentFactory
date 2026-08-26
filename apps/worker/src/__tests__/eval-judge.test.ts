import { describe, expect, it } from "vitest";
import type { EvalLayerResult, PromptSegment } from "@agentfactory/core";
import {
  MAX_ARTEFACT_CHARS,
  buildJudgeUserMessage,
  computeResult,
  selectHumanSegments,
  validateJudgeLayers,
} from "../eval-judge";

const SEGMENTS: PromptSegment[] = [
  { id: "platform_preamble", text: "You are an agent." },
  { id: "team_context", text: "Always update the changelog." },
  { id: "agent_system_prompt", text: "You are a reviewer." },
  { id: "repo_map", text: "src/..." },
];

describe("selectHumanSegments", () => {
  it("keeps only the human-authored layers", () => {
    expect(selectHumanSegments(SEGMENTS).map((s) => s.id)).toEqual(["team_context", "agent_system_prompt"]);
  });

  it("drops human layers whose text is empty (omitted at composition time)", () => {
    const segments: PromptSegment[] = [
      { id: "team_context", text: "", omittedReason: "no_team" },
      { id: "agent_system_prompt", text: "  " },
    ];
    expect(selectHumanSegments(segments)).toEqual([]);
  });
});

describe("buildJudgeUserMessage", () => {
  it("wraps each layer and the artefact in labeled blocks", () => {
    const message = buildJudgeUserMessage(selectHumanSegments(SEGMENTS), { kind: "diff", text: "+added line" });
    expect(message).toContain('<layer id="team_context">');
    expect(message).toContain('<layer id="agent_system_prompt">');
    expect(message).toContain("<artefact>");
    expect(message).toContain("+added line");
    expect(message).toContain("diff");
  });

  it("truncates an oversized artefact and says so", () => {
    const message = buildJudgeUserMessage([], { kind: "diff", text: "x".repeat(MAX_ARTEFACT_CHARS + 100) });
    expect(message).toContain("[artefact truncated]");
    expect(message.length).toBeLessThan(MAX_ARTEFACT_CHARS + 1_000);
  });
});

describe("validateJudgeLayers", () => {
  const VALID = {
    layers: [
      {
        segmentId: "team_context",
        requirements: [{ text: "Update the changelog", verdict: "fail", evidence: "No CHANGELOG edit" }],
      },
    ],
  };

  it("accepts a well-formed report", () => {
    expect(validateJudgeLayers(VALID)).toEqual(VALID.layers);
  });

  it("rejects a segmentId outside the human layers", () => {
    const bad = { layers: [{ segmentId: "repo_map", requirements: [] }] };
    expect(() => validateJudgeLayers(bad)).toThrow(/segmentId/);
  });

  it("rejects an unknown verdict", () => {
    const bad = {
      layers: [{ segmentId: "team_context", requirements: [{ text: "t", verdict: "maybe", evidence: "e" }] }],
    };
    expect(() => validateJudgeLayers(bad)).toThrow(/malformed/);
  });

  it("rejects a missing layers array", () => {
    expect(() => validateJudgeLayers({})).toThrow(/layers/);
  });
});

describe("computeResult", () => {
  it("scores passed over total checkable requirements", () => {
    const layers: EvalLayerResult[] = [
      {
        segmentId: "team_context",
        requirements: [
          { text: "a", verdict: "pass", evidence: "" },
          { text: "b", verdict: "pass", evidence: "" },
          { text: "c", verdict: "fail", evidence: "" },
          { text: "d", verdict: "unclear", evidence: "" },
        ],
      },
    ];
    const result = computeResult(layers, "diff");
    expect(result.score).toBe(0.5);
    expect(result.artefactKind).toBe("diff");
    expect(result.layers).toBe(layers);
  });

  it("scores 0 when there are no checkable requirements — a valid result, not an error", () => {
    const result = computeResult([{ segmentId: "team_context", requirements: [] }], "final_message");
    expect(result.score).toBe(0);
  });
});
