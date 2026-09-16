import type { OutputChunk } from "../sandbox/types";
import type { AgentTurnResult, RuntimeEvent } from "./types";
import { EVENT_MARKER, ERROR_MARKER, RESULT_MARKER } from "./constants";
import { InsufficientCreditError, PromptTooLongError } from "./errors";

// Reads a turn-runner script's stdout/stderr, forwarding __EVENT__ lines to onEvent as they
// arrive and returning the __RESULT__ payload once the stream ends. Shared by every AgentRuntime
// adapter's runTurn() — each adapter only differs in which script it execs and which env vars it
// sets, not in how the sentinel-prefixed stdout lines are read back.
export async function readAgentTurnOutput(
  output: AsyncIterable<OutputChunk>,
  onEvent?: (event: RuntimeEvent) => Promise<void>,
): Promise<AgentTurnResult> {
  let lineBuffer = "";
  let stdout = "";
  let stderr = "";

  const handleLine = async (line: string) => {
    stdout += line + "\n";
    if (onEvent && line.startsWith(EVENT_MARKER)) {
      let payload: RuntimeEvent | undefined;
      try {
        payload = JSON.parse(line.slice(EVENT_MARKER.length)) as RuntimeEvent;
      } catch {
        // ignore malformed (non-JSON) event lines
      }
      if (payload) await onEvent(payload);
    }
  };

  for await (const chunk of output) {
    if (chunk.stream === "stdout") {
      lineBuffer += chunk.data;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) await handleLine(line);
    } else {
      stderr += chunk.data;
    }
  }
  if (lineBuffer) await handleLine(lineBuffer);

  // A successful run always wins: only treat __ERROR__ as authoritative when no valid
  // __RESULT__ line is present. Otherwise a result whose text merely quotes/discusses the
  // literal marker string could be misread as a real failure even though the turn succeeded.
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
  return JSON.parse(resultLine.slice(RESULT_MARKER.length)) as AgentTurnResult;
}
