import { describe, expect, it, vi } from "vitest";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";

// skills-materialize reaches for the db package (whose client throws at import without
// DATABASE_URL) and the storage package (whose createBlobStore reads env). The unit project has
// neither, and .husky/pre-push runs it, so both are mocked at import — same pattern as
// task-documents.test.ts.
const listAgentSkillsMock = vi.fn();
const getSkillVersionMock = vi.fn();
const getSkillVersionMarkdownMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  listAgentSkills: (...args: unknown[]) => listAgentSkillsMock(...args),
  getSkillVersion: (...args: unknown[]) => getSkillVersionMock(...args),
  getSkillVersionMarkdown: (...args: unknown[]) => getSkillVersionMarkdownMock(...args),
}));

const createBlobStoreMock = vi.fn();
vi.mock("@agentfactory/storage", () => ({
  createBlobStore: () => createBlobStoreMock(),
}));

const { materialiseSkills, SKILL_DIR } = await import("../skills-materialize");

function fakeSandboxProvider() {
  const writes: Record<string, string> = {};
  const commands: string[][] = [];
  return {
    create: vi.fn(),
    exec: vi.fn(async function* (_id: string, cmd: string[]): AsyncGenerator<OutputChunk> {
      commands.push(cmd);
    }),
    writeFiles: vi.fn(async (_id: string, files: Record<string, string>) => {
      Object.assign(writes, files);
    }),
    resetMemory: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    _writes: writes,
    _commands: commands,
  };
}

describe("materialiseSkills", () => {
  it("writes each pinned skill's SKILL.md and returns its slug", async () => {
    const sandboxProvider = fakeSandboxProvider();

    const written = await materialiseSkills(sandboxProvider as unknown as SandboxProvider, "sandbox-1", 42, 1, {
      listAgentSkills: async () => [{ skillId: 1, skillVersionId: 10, skillSlug: "foo" }],
      getSkillVersion: async () =>
        ({ id: 10, skillId: 1, version: 1, name: "foo", description: "d", bodySha256: "shaA", createdAt: "" }) as never,
      getSkillVersionMarkdown: async () => "---\nname: foo\ndescription: d\n---\n\nBody",
    });

    expect(written).toEqual(["foo"]);
    expect(sandboxProvider._writes[`${SKILL_DIR}/foo/SKILL.md`]).toContain("Body");
    expect(sandboxProvider._commands).toContainEqual(["mkdir", "-p", `/workspace/${SKILL_DIR}/foo`]);
  });

  it("returns [] when the agent has no pinned skills", async () => {
    const sandboxProvider = fakeSandboxProvider();

    const written = await materialiseSkills(sandboxProvider as unknown as SandboxProvider, "sandbox-1", 42, 1, {
      listAgentSkills: async () => [],
    });

    expect(written).toEqual([]);
    expect(sandboxProvider.writeFiles).not.toHaveBeenCalled();
  });

  it("skips a pin whose blob is missing, without failing", async () => {
    const sandboxProvider = fakeSandboxProvider();

    const written = await materialiseSkills(sandboxProvider as unknown as SandboxProvider, "sandbox-1", 42, 1, {
      listAgentSkills: async () => [{ skillId: 1, skillVersionId: 10, skillSlug: "foo" }],
      getSkillVersion: async () =>
        ({ id: 10, skillId: 1, version: 1, name: "foo", description: "d", bodySha256: "missing", createdAt: "" }) as never,
      getSkillVersionMarkdown: async () => undefined,
    });

    expect(written).toEqual([]);
    expect(sandboxProvider.writeFiles).not.toHaveBeenCalled();
  });

  it("returns [] and logs rather than throwing when listAgentSkills rejects", async () => {
    const sandboxProvider = fakeSandboxProvider();

    const written = await materialiseSkills(sandboxProvider as unknown as SandboxProvider, "sandbox-1", 42, 1, {
      listAgentSkills: async () => {
        throw new Error("db down");
      },
    });

    expect(written).toEqual([]);
    expect(sandboxProvider.writeFiles).not.toHaveBeenCalled();
  });

  it("writes into a custom skillDir when provided", async () => {
    const sandboxProvider = fakeSandboxProvider();

    const written = await materialiseSkills(sandboxProvider as unknown as SandboxProvider, "sandbox-1", 42, 1, {
      skillDir: ".agents/skills",
      listAgentSkills: async () => [{ skillId: 1, skillVersionId: 10, skillSlug: "foo" }],
      getSkillVersion: async () =>
        ({ id: 10, skillId: 1, version: 1, name: "foo", description: "d", bodySha256: "shaA", createdAt: "" }) as never,
      getSkillVersionMarkdown: async () => "---\nname: foo\ndescription: d\n---\n\nBody",
    });

    expect(written).toEqual(["foo"]);
    expect(sandboxProvider._writes[".agents/skills/foo/SKILL.md"]).toContain("Body");
    expect(sandboxProvider._commands).toContainEqual(["mkdir", "-p", "/workspace/.agents/skills/foo"]);
  });
});
