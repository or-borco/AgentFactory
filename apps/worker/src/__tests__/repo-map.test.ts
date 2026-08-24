import { describe, expect, it, vi } from "vitest";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";

const getRepoMapMock = vi.fn();
const insertRepoMapMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getRepoMap: (...args: unknown[]) => getRepoMapMock(...args),
  insertRepoMap: (...args: unknown[]) => insertRepoMapMock(...args),
}));

const { ensureRepoMap } = await import("../repo-map");

function fakeSandbox(execResults: Record<string, OutputChunk[]>): SandboxProvider {
  return {
    create: vi.fn(),
    exec: (async function* (id: string, cmd: string[]) {
      const key = cmd.join(" ");
      const chunks = execResults[key];
      if (!chunks) throw new Error(`No fake exec result registered for: ${key}`);
      for (const chunk of chunks) yield chunk;
    }) as SandboxProvider["exec"],
    writeFiles: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    resetMemory: vi.fn(),
  };
}

const HEAD_CMD = "git -C /workspace rev-parse HEAD";
const GENERATE_CMD = "/agent/node_modules/.bin/tsx /agent/generate-repo-map.ts";

describe("ensureRepoMap", () => {
  it("returns the cached map without invoking the generation script on a cache hit", async () => {
    getRepoMapMock.mockReset().mockResolvedValue({ content: "cached map" });
    insertRepoMapMock.mockReset();
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
    });

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");

    expect(result).toBe("cached map");
    expect(getRepoMapMock).toHaveBeenCalledWith(1, "acme/widgets", "abc123");
    expect(insertRepoMapMock).not.toHaveBeenCalled();
  });

  it("generates and caches a map on a cache miss", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset().mockResolvedValue(undefined);
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
      [GENERATE_CMD]: [
        { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "generated map", costUsd: 0.01, tokens: 500 })}\n` },
      ],
    });

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");

    expect(result).toBe("generated map");
    expect(insertRepoMapMock).toHaveBeenCalledWith({
      orgId: 1,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "generated map",
      generationCostUsd: 0.01,
      generationTokens: 500,
    });
  });

  it("returns an empty string without throwing when generation produces no result line", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset();
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
      [GENERATE_CMD]: [{ stream: "stderr", data: "container crashed\n" }],
    });

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");

    expect(result).toBe("");
    expect(insertRepoMapMock).not.toHaveBeenCalled();
  });

  it("returns an empty string without throwing when the generation exec itself throws", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset();
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: (async function* (_id: string, cmd: string[]) {
        if (cmd.join(" ") === HEAD_CMD) {
          yield { stream: "stdout", data: "abc123\n" } as OutputChunk;
          return;
        }
        throw new Error("sandbox exec failed");
      }) as SandboxProvider["exec"],
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");
    expect(result).toBe("");
  });
});
