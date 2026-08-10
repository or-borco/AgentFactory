import type { ModelSpec } from "@agentfactory/core";
import type { SandboxProvider } from "./sandbox/types";
import { cloneIntoSandbox, type CloneTarget } from "./scm-provider";

export interface AgentTurnResult {
  text: string;
  providerSessionRef: string;
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
  workspace?: CloneTarget;
  onEvent?: (type: string, data: Record<string, unknown>) => Promise<void>;
}): Promise<AgentTurnResult> {
  const { sandboxProvider, sandboxId, systemPrompt, model, userText, resumeSessionRef, workspace, onEvent } = params;

  if (workspace) {
    await cloneIntoSandbox(sandboxProvider, sandboxId, workspace);
  }

  const env: Record<string, string> = {
    SYSTEM_PROMPT: systemPrompt,
    USER_TEXT: userText,
    MODEL_ID: model.id,
    // Platform key passthrough for now — see the plan's credential note: this becomes
    // resolveCredentials(orgId) once BYO-key connections exist (ARCHITECTURE.md §9).
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  };
  if (resumeSessionRef) env.RESUME_SESSION_REF = resumeSessionRef;

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

  const errorIndex = stdout.lastIndexOf(ERROR_MARKER);
  if (errorIndex !== -1) {
    const errorLine = stdout.slice(errorIndex + ERROR_MARKER.length).split("\n")[0];
    const errorPayload = JSON.parse(errorLine) as { code: string };
    if (errorPayload.code === "prompt_too_long") throw new PromptTooLongError();
  }

  const markerIndex = stdout.lastIndexOf(RESULT_MARKER);
  if (markerIndex === -1) {
    throw new Error(`Sandbox run produced no result line. stdout: ${stdout}\nstderr: ${stderr}`);
  }
  const jsonLine = stdout.slice(markerIndex + RESULT_MARKER.length).split("\n")[0];
  const parsed = JSON.parse(jsonLine) as AgentTurnResult;
  return parsed;
}
