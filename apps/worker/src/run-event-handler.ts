import { CURRENT_KEY_VERSION, createEvent as createEventDefault, encryptSecret as encryptSecretDefault } from "@agentfactory/db";
import { createLogger } from "@agentfactory/logger";
import type { RuntimeEvent, ThinkingDeltaRuntimeEvent, ToolResultRuntimeEvent } from "./agent-runtime/types";
import { writeMemoryEntry as writeMemoryEntryDefault } from "./memory-write";
import { MAX_MASK_INPUT_CHARS, keepTail, maskSecrets, truncateMiddle } from "./secret-masking";

const log = createLogger("run-event-handler");

export const MAX_STORED_FAILURE_CHARS = 2_000;

export interface RunEventContext {
  runId: number;
  orgId: number;
  agentId: number;
  sessionId: number;
  runSecrets: readonly string[];
  nextSeq: () => number;
}

export interface RunEventDeps {
  createEvent: (runId: number, seq: number, type: string, data: Record<string, unknown>) => Promise<unknown>;
  encryptSecret: (plaintext: Record<string, string>) => string;
  writeMemoryEntry: typeof writeMemoryEntryDefault;
}

const defaultDeps: RunEventDeps = {
  createEvent: createEventDefault,
  encryptSecret: encryptSecretDefault,
  writeMemoryEntry: writeMemoryEntryDefault,
};

function maskOptional(value: unknown, secrets: readonly string[]): string | undefined {
  return typeof value === "string" ? maskSecrets(value, secrets) : undefined;
}

function toolResultData(event: ToolResultRuntimeEvent, ctx: RunEventContext, deps: RunEventDeps): Record<string, unknown> {
  const inputSummary = maskOptional(event.inputSummary, ctx.runSecrets);
  const command = maskOptional(event.command, ctx.runSecrets);
  const base = {
    toolUseId: event.toolUseId,
    tool: event.tool,
    ...(inputSummary !== undefined ? { inputSummary } : {}),
    ...(command !== undefined ? { command } : {}),
    isError: event.isError === true,
    subagent: event.subagent === true,
  };
  if (!base.isError) return base;
  const raw = typeof event.output === "string" ? event.output : "";
  const output = truncateMiddle(maskSecrets(keepTail(raw, MAX_MASK_INPUT_CHARS), ctx.runSecrets), MAX_STORED_FAILURE_CHARS);
  return { ...base, keyVersion: CURRENT_KEY_VERSION, ciphertext: deps.encryptSecret({ output }) };
}

function maskedThinking(event: ThinkingDeltaRuntimeEvent, secrets: readonly string[]): Record<string, unknown> {
  return {
    ...event,
    text: maskSecrets(event.text, secrets),
    ...(event.command !== undefined ? { command: maskSecrets(event.command, secrets) } : {}),
    ...(event.description !== undefined ? { description: maskSecrets(event.description, secrets) } : {}),
  };
}

export function createRunEventHandler(ctx: RunEventContext, deps: Partial<RunEventDeps> = {}) {
  const d = { ...defaultDeps, ...deps };
  return async (event: RuntimeEvent): Promise<void> => {
    if (event.type === "memory_write") {
      let reinforced = false;
      try {
        ({ reinforced } = await d.writeMemoryEntry(ctx.orgId, ctx.agentId, event.content, "manual", {
          runId: ctx.runId,
          sessionId: ctx.sessionId,
        }));
      } catch (err) {
        log.error("Failed to write memory entry", { runId: ctx.runId, agentId: ctx.agentId, err });
      }
      await d.createEvent(ctx.runId, ctx.nextSeq(), "memory_write", { reinforced });
      return;
    }
    if (event.type === "tool_result") {
      if (typeof event.toolUseId !== "string" || typeof event.tool !== "string") {
        log.warn("Dropped malformed tool_result event", { runId: ctx.runId });
        return;
      }
      try {
        const data = toolResultData(event, ctx, d);
        await d.createEvent(ctx.runId, ctx.nextSeq(), "tool_result", data);
      } catch (err) {
        log.error("Failed to store tool result", { runId: ctx.runId, err });
      }
      return;
    }
    if (event.type === "thinking_delta") {
      await d.createEvent(ctx.runId, ctx.nextSeq(), event.type, maskedThinking(event, ctx.runSecrets));
      return;
    }
    await d.createEvent(ctx.runId, ctx.nextSeq(), (event as { type: string }).type, { ...(event as object) });
  };
}
