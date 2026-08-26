import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MODEL_ID,
  type EvalArtefactKind,
  type EvalLayerResult,
  type EvalVerdict,
  type PromptSegment,
  type RunEvalResult,
} from "@agentfactory/core";
import type { EvalArtefact } from "./eval-artefact";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Only human-authored layers are graded. Preamble, environment, and repo map are platform
// boilerplate — scoring the agent against them measures nothing about the team's context.
export const HUMAN_SEGMENT_IDS: ReadonlySet<string> = new Set(["team_context", "agent_system_prompt"]);

export function selectHumanSegments(segments: PromptSegment[]): PromptSegment[] {
  return segments.filter((segment) => HUMAN_SEGMENT_IDS.has(segment.id) && segment.text.trim() !== "");
}

// A 500 KB diff would blow the judge's context; cap the artefact and say so in the prompt.
// The cap is generous — a truncated verdict on a real diff beats a clean failure on size.
export const MAX_ARTEFACT_CHARS = 120_000;

export const JUDGE_MAX_TOKENS = 8_192;

const JUDGE_SYSTEM_PROMPT = [
  "You are a strict compliance judge. You are given (1) instruction layers that were part of",
  "an AI coding agent's system prompt, and (2) the artefact that agent produced.",
  "",
  "For each layer, extract its concrete, checkable requirements. Skip aspirational or vague",
  'statements (e.g. "write good code") entirely — do not list them, do not fail them.',
  "",
  'Then judge each requirement against the artefact alone: verdict "pass" if the artefact',
  'demonstrably complies, "fail" if it demonstrably violates or omits it, "unclear" if the',
  "artefact does not show enough to decide. Never assume work happened outside the artefact.",
  "For evidence, quote the single most relevant line from the artefact, or state in one",
  "short sentence what is absent.",
  "",
  "Report exclusively through the report_eval tool.",
].join("\n");

const REPORT_EVAL_TOOL: Anthropic.Tool = {
  name: "report_eval",
  description: "Report the per-layer compliance verdicts for the artefact.",
  input_schema: {
    type: "object",
    required: ["layers"],
    properties: {
      layers: {
        type: "array",
        items: {
          type: "object",
          required: ["segmentId", "requirements"],
          properties: {
            segmentId: { type: "string", enum: ["team_context", "agent_system_prompt"] },
            requirements: {
              type: "array",
              items: {
                type: "object",
                required: ["text", "verdict", "evidence"],
                properties: {
                  text: { type: "string" },
                  verdict: { type: "string", enum: ["pass", "fail", "unclear"] },
                  evidence: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function buildJudgeUserMessage(segments: PromptSegment[], artefact: EvalArtefact): string {
  const layerBlocks = segments
    .map((segment) => `<layer id="${segment.id}">\n${segment.text}\n</layer>`)
    .join("\n\n");
  const truncated = artefact.text.length > MAX_ARTEFACT_CHARS;
  const body = truncated
    ? `${artefact.text.slice(0, MAX_ARTEFACT_CHARS)}\n…[artefact truncated]`
    : artefact.text;
  const kindLabel =
    artefact.kind === "diff"
      ? "the diff the agent's branch introduced"
      : "the agent's final reply message (it committed no code)";
  return `Instruction layers:\n\n${layerBlocks}\n\nThe artefact to judge — ${kindLabel}:\n\n<artefact>\n${body}\n</artefact>`;
}

const VERDICTS: ReadonlySet<string> = new Set(["pass", "fail", "unclear"]);

// The API's forced tool_choice already constrains the shape, but the eval fails cleanly on
// any drift rather than storing garbage — "it parses or the eval fails" (spec).
export function validateJudgeLayers(input: unknown): EvalLayerResult[] {
  const layers = (input as { layers?: unknown } | undefined)?.layers;
  if (!Array.isArray(layers)) throw new Error("judge output has no layers array");
  return layers.map((layer) => {
    const { segmentId, requirements } = (layer ?? {}) as { segmentId?: unknown; requirements?: unknown };
    if (typeof segmentId !== "string" || !HUMAN_SEGMENT_IDS.has(segmentId)) {
      throw new Error(`judge output has an invalid segmentId: ${String(segmentId)}`);
    }
    if (!Array.isArray(requirements)) throw new Error("judge output layer has no requirements array");
    return {
      segmentId,
      requirements: requirements.map((requirement) => {
        const { text, verdict, evidence } = (requirement ?? {}) as Record<string, unknown>;
        if (
          typeof text !== "string" ||
          typeof evidence !== "string" ||
          typeof verdict !== "string" ||
          !VERDICTS.has(verdict)
        ) {
          throw new Error("judge output requirement is malformed");
        }
        return { text, verdict: verdict as EvalVerdict, evidence };
      }),
    };
  });
}

// The score is computed here, never trusted from the model.
export function computeResult(layers: EvalLayerResult[], artefactKind: EvalArtefactKind): RunEvalResult {
  const requirements = layers.flatMap((layer) => layer.requirements);
  const passed = requirements.filter((requirement) => requirement.verdict === "pass").length;
  // Zero checkable requirements is a valid result, not an error — score 0 by the spec.
  const score = requirements.length === 0 ? 0 : passed / requirements.length;
  return { artefactKind, layers, score };
}

// One structured-output call: requirement extraction and verdicting in a single pass, the
// response forced into shape by tool_choice. Not unit-tested (network); everything around
// it is, and eval-runner injects it as a dependency.
export async function judgeCompliance(
  segments: PromptSegment[],
  artefact: EvalArtefact,
): Promise<{ result: RunEvalResult; judgeModelId: string }> {
  const response = await client.messages.create({
    model: DEFAULT_MODEL_ID,
    max_tokens: JUDGE_MAX_TOKENS,
    system: JUDGE_SYSTEM_PROMPT,
    tools: [REPORT_EVAL_TOOL],
    tool_choice: { type: "tool", name: "report_eval" },
    messages: [{ role: "user", content: buildJudgeUserMessage(segments, artefact) }],
  });
  const toolUse = response.content.find((block) => block.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("judge returned no report_eval tool call");
  const layers = validateJudgeLayers(toolUse.input);
  return { result: computeResult(layers, artefact.kind), judgeModelId: DEFAULT_MODEL_ID };
}
