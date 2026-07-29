// Temporary placeholder standing in for a real AgentRuntime (see ARCHITECTURE.md) — a hardcoded
// canned-reply generator until the Claude Agent SDK integration lands.
export function draftReplyFor(agentId: number | undefined, userText: string): string {
  if (agentId === 1) {
    return (
      "Looking at this now. Based on the diff: the changed files pass lint, but I'd flag the new error path in " +
      "the handler — it swallows the original exception instead of wrapping it, which will make this hard to " +
      "debug in production. I'll leave an inline comment on that line and a couple of minor naming suggestions. " +
      "Nothing here blocks merging once that's addressed."
    );
  }
  return (
    `Got it — "${userText.slice(0, 80)}${userText.length > 80 ? "…" : ""}" ` +
    "This is a simulated reply from the mocked backend; wire this session up to a real AgentRuntime to get " +
    "actual model output here."
  );
}
