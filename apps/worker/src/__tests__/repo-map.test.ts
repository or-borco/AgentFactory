import { describe, expect, it, vi } from "vitest";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";

const getRepoMapMock = vi.fn();
const insertRepoMapMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getRepoMap: (...args: unknown[]) => getRepoMapMock(...args),
  insertRepoMap: (...args: unknown[]) => insertRepoMapMock(...args),
}));

// repo-map.ts now imports the warm queue, whose module body throws unless REDIS_URL is set —
// mocked here so this stays a unit test with no Redis dependency, the same way @agentfactory/db is.
const enqueueRepoMapWarmJobMock = vi.fn();
vi.mock("@agentfactory/queue", () => ({
  enqueueRepoMapWarmJob: (...args: unknown[]) => enqueueRepoMapWarmJobMock(...args),
}));

const resolveDefaultBranchShaMock = vi.fn();
const resolveCloneTargetMock = vi.fn();
const cloneIntoSandboxMock = vi.fn();
// Path is relative to this test file, not to repo-map.ts — Vitest resolves vi.mock specifiers
// against the calling module, and both resolve to the same apps/worker/src/scm-provider.ts.
vi.mock("../scm-provider", () => ({
  resolveDefaultBranchSha: (...args: unknown[]) => resolveDefaultBranchShaMock(...args),
  resolveCloneTarget: (...args: unknown[]) => resolveCloneTargetMock(...args),
  cloneIntoSandbox: (...args: unknown[]) => cloneIntoSandboxMock(...args),
}));

const { ensureRepoMap, warmRepoMap } = await import("../repo-map");

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
    enqueueRepoMapWarmJobMock.mockReset().mockResolvedValue(undefined);
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
    });

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");

    expect(result).toBe("cached map");
    expect(getRepoMapMock).toHaveBeenCalledWith(1, "acme/widgets", "abc123");
    expect(insertRepoMapMock).not.toHaveBeenCalled();
    expect(enqueueRepoMapWarmJobMock).not.toHaveBeenCalled();
  });

  // The core of the latency fix: a miss must not run the generation turn inline. fakeSandbox
  // throws on any command it has no registered result for, so registering only HEAD_CMD means
  // this test fails loudly if ensureRepoMap ever reaches for GENERATE_CMD again.
  it("defers generation to the warm queue on a cache miss instead of blocking the run", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset();
    enqueueRepoMapWarmJobMock.mockReset().mockResolvedValue(undefined);
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
    });

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");

    expect(result).toBe("");
    expect(enqueueRepoMapWarmJobMock).toHaveBeenCalledWith(1, "acme/widgets");
    expect(insertRepoMapMock).not.toHaveBeenCalled();
  });

  it("still returns an empty string when the warm job cannot even be enqueued", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    enqueueRepoMapWarmJobMock.mockReset().mockRejectedValue(new Error("redis down"));
    const sandbox = fakeSandbox({
      [HEAD_CMD]: [{ stream: "stdout", data: "abc123\n" }],
    });

    await expect(ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets")).resolves.toBe("");
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

  it("returns an empty string without throwing when the HEAD-sha lookup itself throws", async () => {
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset();
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: (async function* (_id: string, cmd: string[]) {
        if (cmd.join(" ") === HEAD_CMD) {
          throw new Error("git command failed");
        }
        throw new Error("unexpected command");
      }) as SandboxProvider["exec"],
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    const result = await ensureRepoMap(sandbox, "sandbox-1", 1, "acme/widgets");
    expect(result).toBe("");
    expect(insertRepoMapMock).not.toHaveBeenCalled();
  });
});

describe("warmRepoMap", () => {
  it("never creates a sandbox when the default branch's sha is already cached", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue({ content: "cached" });
    const create = vi.fn();
    const sandbox: SandboxProvider = {
      create,
      exec: vi.fn(),
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local");

    expect(create).not.toHaveBeenCalled();
  });

  it("provisions, clones, generates, and tears down on a cache miss", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    insertRepoMapMock.mockReset().mockResolvedValue(undefined);
    resolveCloneTargetMock.mockReset().mockResolvedValue({
      cloneUrl: "https://x-access-token:tok@github.com/acme/widgets.git",
      branch: "main",
      repoFullName: "acme/widgets",
      installationId: 1,
    });
    cloneIntoSandboxMock.mockReset().mockResolvedValue(undefined);
    const destroy = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: "warm-sandbox-1" });
    const sandbox: SandboxProvider = {
      create,
      exec: (async function* (_id: string, cmd: string[]) {
        if (cmd.join(" ") === "git -C /workspace rev-parse HEAD") {
          yield { stream: "stdout", data: "abc123\n" } as OutputChunk;
          return;
        }
        yield {
          stream: "stdout",
          data: `__RESULT__${JSON.stringify({ text: "warmed map", costUsd: 0, tokens: 100 })}\n`,
        } as OutputChunk;
      }) as SandboxProvider["exec"],
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy,
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local");

    expect(create).toHaveBeenCalledWith({ image: "agentfactory-sandbox:local", env: expect.any(Object) });
    expect(cloneIntoSandboxMock).toHaveBeenCalled();
    expect(insertRepoMapMock).toHaveBeenCalledWith(expect.objectContaining({ content: "warmed map" }));
    expect(destroy).toHaveBeenCalledWith("warm-sandbox-1");
  });

  it("still tears down the sandbox when clone fails after it was created", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    resolveCloneTargetMock.mockReset().mockResolvedValue({
      cloneUrl: "https://x-access-token:tok@github.com/acme/widgets.git",
      branch: "main",
      repoFullName: "acme/widgets",
      installationId: 1,
    });
    cloneIntoSandboxMock.mockReset().mockRejectedValue(new Error("clone failed"));
    const destroy = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: "warm-sandbox-2" });
    const sandbox: SandboxProvider = {
      create,
      exec: vi.fn(),
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy,
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await expect(warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local")).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledWith("warm-sandbox-2");
  });

  it("does not throw when destroy itself fails after a generation error", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    resolveCloneTargetMock.mockReset().mockResolvedValue({
      cloneUrl: "https://x-access-token:tok@github.com/acme/widgets.git",
      branch: "main",
      repoFullName: "acme/widgets",
      installationId: 1,
    });
    cloneIntoSandboxMock.mockReset().mockResolvedValue(undefined);
    const destroy = vi.fn().mockRejectedValue(new Error("docker teardown failed"));
    const create = vi.fn().mockResolvedValue({ id: "warm-sandbox-3" });
    const sandbox: SandboxProvider = {
      create,
      exec: (async function* () {
        yield { stream: "stderr", data: "boom\n" } as OutputChunk;
      }) as SandboxProvider["exec"],
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy,
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await expect(warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local")).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalledWith("warm-sandbox-3");
  });

  it("does not throw when sandbox creation itself fails", async () => {
    resolveDefaultBranchShaMock.mockReset().mockResolvedValue("abc123");
    getRepoMapMock.mockReset().mockResolvedValue(undefined);
    resolveCloneTargetMock.mockReset().mockResolvedValue({
      cloneUrl: "https://x-access-token:tok@github.com/acme/widgets.git",
      branch: "main",
      repoFullName: "acme/widgets",
      installationId: 1,
    });
    const destroy = vi.fn();
    const create = vi.fn().mockRejectedValue(new Error("docker unavailable"));
    const sandbox: SandboxProvider = {
      create,
      exec: vi.fn(),
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy,
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await expect(warmRepoMap(sandbox, 1, "acme/widgets", "agentfactory-sandbox:local")).resolves.toBeUndefined();
    expect(destroy).not.toHaveBeenCalled();
  });
});
