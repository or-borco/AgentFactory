import type { RuntimeKind } from "@agentfactory/core";
import { claudeCodeRuntime } from "./claude-code-runtime";
import type { AgentRuntime } from "./types";

// Exported (rather than a private module constant) so registry.test.ts can register a stub
// second runtime to exercise multi-runtime dispatch — production code never pushes to this
// beyond the fixed list below; there is exactly one real adapter until a second one ships.
export const runtimes: AgentRuntime[] = [claudeCodeRuntime]; // future: push a second adapter here

export function getAgentRuntime(kind: RuntimeKind): AgentRuntime {
  const runtime = runtimes.find((r) => r.kind === kind);
  if (!runtime) throw new Error(`No AgentRuntime registered for kind "${kind}"`);
  return runtime;
}
