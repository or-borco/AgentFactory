import type { ModelSpec } from "@agentfactory/core";
import type { SandboxProvider } from "./sandbox/types";

export interface AgentTurnResult {
  text: string;
  providerSessionRef: string;
  structuredOutput?: unknown;
}

// Must match RESULT_MARKER in apps/worker/sandbox-image/run-turn.ts.
const RESULT_MARKER = "__RESULT__";
// Must match EVENT_MARKER in apps/worker/sandbox-image/run-turn.ts.
const EVENT_MARKER = "__EVENT__";
// Must match ERROR_MARKER in apps/worker/sandbox-image/run-turn.ts.
const ERROR_MARKER = "__ERROR__";

export class PromptTooLongError extends Error {
  constructor() {
    super("Prompt is too long for the assigned model's context window");
    this.name = "PromptTooLongError";
  }
}

// Thrown when the sandbox reports that the Claude API rejected the turn because the org's
// account has run out of usage credits (run-turn.ts matches Anthropic's "credit balance" error
// text). Kept distinct from the generic failure path so worker.ts can classify the resulting
// run event with ErrorCode "insufficient_credit" instead of a one-size-fits-all message.
export class InsufficientCreditError extends Error {
  constructor() {
    super("The connected Claude API account has run out of usage credits");
    this.name = "InsufficientCreditError";
  }
}

// The Claude Agent SDK call now runs *inside* the sandbox (apps/worker/sandbox-image/run-turn.ts),
// not on the worker's own host process — this function just execs into it and parses the one
// sentinel-prefixed result line back out. `resumeSessionRef` carries the prior turn's provider
// session id (from runs.provider_session_ref); it only resolves because the sandbox is the same
// container across a session's runs (see worker.ts's ensureSandbox) — the SDK's session state
// lives on that container's filesystem, not server-side.
export async function runAgentTurn(params: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
  systemPrompt: string;
  model: ModelSpec;
  userText: string;
  resumeSessionRef?: string;
  skillNames?: string[];
  outputSchema?: Record<string, unknown>;
  onEvent?: (type: string, data: Record<string, unknown>) => Promise<void>;
}): Promise<AgentTurnResult> {
  const { sandboxProvider, sandboxId, systemPrompt, model, userText, resumeSessionRef, skillNames, outputSchema, onEvent } =
    params;

  // The caller (worker.ts) already cloned into this sandbox before composing the prompt — this
  // used to re-run cloneIntoSandbox here, which on a warm /workspace does nothing but pay for an
  // extra docker exec round trip (~55ms measured) to be told ALREADY_CLONED. Cloning is the
  // pipeline's job, not the turn's.
  const env: Record<string, string> = {
    SYSTEM_PROMPT: systemPrompt,
    USER_TEXT: userText,
    MODEL_ID: model.id,
    // Platform key passthrough for now — see the plan's credential note: this becomes
    // resolveCredentials(orgId) once BYO-key connections exist (ARCHITECTURE.md §9).
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  };
  if (resumeSessionRef) env.RESUME_SESSION_REF = resumeSessionRef;
  if (skillNames && skillNames.length > 0) {
    env.SKILL_NAMES = skillNames.join(",");
  }
  if (outputSchema) env.OUTPUT_SCHEMA = JSON.stringify(outputSchema);

  let lineBuffer = "";
  let stdout = "";
  let stderr = "";
  for await (const chunk of sandboxProvider.exec(
    sandboxId,
    ["/agent/node_modules/.bin/tsx", "/agent/run-turn.ts"],
    { env },
  )) {
    if (chunk.stream === "stdout") {
      lineBuffer += chunk.data;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        stdout += line + "\n";
        if (onEvent && line.startsWith(EVENT_MARKER)) {
          let payload: ({ type: string } & Record<string, unknown>) | undefined;
          try {
            payload = JSON.parse(line.slice(EVENT_MARKER.length)) as { type: string } & Record<string, unknown>;
          } catch {
            // ignore malformed (non-JSON) event lines
          }
          if (payload) await onEvent(payload.type, payload);
        }
      }
    } else {
      stderr += chunk.data;
    }
  }
  if (lineBuffer) {
    stdout += lineBuffer;
    if (onEvent && lineBuffer.startsWith(EVENT_MARKER)) {
      let payload: ({ type: string } & Record<string, unknown>) | undefined;
      try {
        payload = JSON.parse(lineBuffer.slice(EVENT_MARKER.length)) as { type: string } & Record<string, unknown>;
      } catch {
        // ignore malformed (non-JSON) event lines
      }
      if (payload) await onEvent(payload.type, payload);
    }
  }

  // A successful run always wins: only treat __ERROR__ as authoritative when no valid
  // __RESULT__ line is present. Otherwise a result whose text merely quotes/discusses the
  // literal marker string (e.g. an agent asked to explain run-turn.ts, which contains it)
  // could be misread as a real failure even though the turn actually succeeded.
  const resultLine = stdout.split("\n").find((line) => line.startsWith(RESULT_MARKER));
  if (!resultLine) {
    const errorLine = stdout.split("\n").find((line) => line.startsWith(ERROR_MARKER));
    if (errorLine) {
      let errorPayload: { code: string } | undefined;
      try {
        errorPayload = JSON.parse(errorLine.slice(ERROR_MARKER.length)) as { code: string };
      } catch {
        // malformed error line — fall through to the generic failure below
      }
      if (errorPayload?.code === "prompt_too_long") throw new PromptTooLongError();
      if (errorPayload?.code === "insufficient_credit") throw new InsufficientCreditError();
    }
    throw new Error(`Sandbox run produced no result line. stdout: ${stdout}\nstderr: ${stderr}`);
  }
  const jsonLine = resultLine.slice(RESULT_MARKER.length);
  const parsed = JSON.parse(jsonLine) as AgentTurnResult;
  return parsed;
}
