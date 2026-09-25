import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentfactory/db", () => ({
  CURRENT_KEY_VERSION: 1,
  createEvent: vi.fn(),
  encryptSecret: vi.fn(),
  findSimilarMemoryEntry: vi.fn(),
  insertMemoryEntryWithWrite: vi.fn(),
  reinforceMemoryEntryWithWrite: vi.fn(),
}));

const { createRunEventHandler } = await import("../run-event-handler");

const TOKEN = "arata-run-Zx9_Qw8-Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm";

function setup() {
  let seq = 1;
  const createEvent = vi.fn().mockResolvedValue(undefined);
  const encryptSecret = vi.fn((plain: Record<string, string>) => `enc(${plain.output})`);
  const writeMemoryEntry = vi.fn().mockResolvedValue({ reinforced: false });
  const handler = createRunEventHandler(
    { runId: 7, orgId: 1, agentId: 2, sessionId: 3, runSecrets: [TOKEN], nextSeq: () => seq++ },
    { createEvent, encryptSecret, writeMemoryEntry },
  );
  return { handler, createEvent, encryptSecret, writeMemoryEntry };
}

describe("createRunEventHandler: tool_result", () => {
  it("masks, truncates and encrypts failure output, with no plaintext output in data", async () => {
    const { handler, createEvent } = setup();
    const output = `${"a".repeat(3_000)} key ${TOKEN} ${"z".repeat(3_000)}`;
    await handler({
      type: "tool_result",
      toolUseId: "tu_1",
      tool: "Bash",
      inputSummary: `curl -H "Authorization: Bearer ${TOKEN}"`,
      command: `echo ${TOKEN}`,
      output,
      isError: true,
      subagent: false,
    });

    const [runId, seq, type, data] = createEvent.mock.calls[0];
    expect([runId, seq, type]).toEqual([7, 1, "tool_result"]);
    expect(data).not.toHaveProperty("output");
    expect(data).toMatchObject({ toolUseId: "tu_1", tool: "Bash", isError: true, subagent: false, keyVersion: 1 });
    expect(JSON.stringify(data)).not.toContain(TOKEN);
    const stored = (data.ciphertext as string).slice(4, -1);
    expect(stored.startsWith("a".repeat(500))).toBe(true);
    expect(stored).toContain("\n…[truncated]…\n");
    expect(stored.endsWith("z".repeat(1_500))).toBe(true);
  });

  it("stores a success marker with no output and no ciphertext", async () => {
    const { handler, createEvent, encryptSecret } = setup();
    await handler({ type: "tool_result", toolUseId: "tu_2", tool: "Edit", inputSummary: "Edit: a.ts", isError: false });
    expect(encryptSecret).not.toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledWith(7, 1, "tool_result", {
      toolUseId: "tu_2",
      tool: "Edit",
      inputSummary: "Edit: a.ts",
      isError: false,
      subagent: false,
    });
  });

  it("drops a malformed tool_result without consuming a seq", async () => {
    const { handler, createEvent } = setup();
    await handler({ type: "tool_result", toolUseId: 5, tool: "Bash", isError: true } as never);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it("logs and continues when encryption throws", async () => {
    const { handler, createEvent, encryptSecret } = setup();
    encryptSecret.mockImplementation(() => {
      throw new Error("CONNECTION_SECRET_KEY is not set");
    });
    await expect(
      handler({ type: "tool_result", toolUseId: "tu_1", tool: "Bash", output: "boom", isError: true }),
    ).resolves.toBeUndefined();
    expect(createEvent).not.toHaveBeenCalled();
  });
});

describe("createRunEventHandler: thinking_delta", () => {
  it("masks command, description and text before storing", async () => {
    const { handler, createEvent } = setup();
    await handler({
      type: "thinking_delta",
      tool: "Bash",
      command: `git push https://x-access-token:${TOKEN}@github.com/o/r`,
      description: `use ${TOKEN}`,
      text: `[Bash] ${TOKEN}\n`,
    });
    const data = createEvent.mock.calls[0][3];
    expect(JSON.stringify(data)).not.toContain(TOKEN);
    expect(data.tool).toBe("Bash");
  });

  it("stores plain reasoning unchanged", async () => {
    const { handler, createEvent } = setup();
    await handler({ type: "thinking_delta", text: "Let me look at the tests." });
    expect(createEvent).toHaveBeenCalledWith(7, 1, "thinking_delta", { type: "thinking_delta", text: "Let me look at the tests." });
  });
});

describe("createRunEventHandler: memory_write", () => {
  it("writes the memory entry and stores only the reinforced flag", async () => {
    const { handler, createEvent, writeMemoryEntry } = setup();
    writeMemoryEntry.mockResolvedValue({ reinforced: true });
    await handler({ type: "memory_write", content: "Use pnpm." });
    expect(writeMemoryEntry).toHaveBeenCalledWith(1, 2, "Use pnpm.", "manual", { runId: 7, sessionId: 3 });
    expect(createEvent).toHaveBeenCalledWith(7, 1, "memory_write", { reinforced: true });
  });

  it("still stores the event when the write fails", async () => {
    const { handler, createEvent, writeMemoryEntry } = setup();
    writeMemoryEntry.mockRejectedValue(new Error("db down"));
    await handler({ type: "memory_write", content: "Use pnpm." });
    expect(createEvent).toHaveBeenCalledWith(7, 1, "memory_write", { reinforced: false });
  });
});
