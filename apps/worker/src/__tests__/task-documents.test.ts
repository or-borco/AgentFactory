import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskContextItem } from "@agentfactory/core";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";

// task-documents reaches for the db package (whose client throws at import without DATABASE_URL)
// and the storage package (whose createBlobStore reads env). The unit project has neither, and
// .husky/pre-push runs it, so both are mocked at import — same pattern as context-retrieval.test.ts.
const listTaskContextItemsForOrgMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  listTaskContextItemsForOrg: (...args: unknown[]) => listTaskContextItemsForOrgMock(...args),
}));

const createBlobStoreMock = vi.fn();
vi.mock("@agentfactory/storage", () => ({
  createBlobStore: () => createBlobStoreMock(),
}));

const {
  TASK_DOCUMENT_DIR,
  TASK_DOCUMENT_EXCLUDE_PATTERN,
  TASK_DOCUMENTS_BUDGET_BYTES,
  materialiseTaskDocuments,
  sanitiseDocumentName,
} = await import("../task-documents");

const encoder = new TextEncoder();

function item(over: Partial<TaskContextItem> & { id: number; title: string }): TaskContextItem {
  return {
    taskId: 70,
    orgId: 1,
    sizeBytes: 100,
    sha256: `${over.id}`.padStart(64, "0"),
    mime: "text/markdown",
    source: "upload",
    status: "indexed",
    createdAt: new Date("2026-09-03T00:00:00Z").toISOString(),
    ...over,
  } as TaskContextItem;
}

function fakeSandbox(over: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    create: vi.fn(),
    // eslint-disable-next-line require-yield
    exec: vi.fn(async function* (): AsyncGenerator<OutputChunk> {}),
    writeFiles: vi.fn(),
    resetMemory: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    ...over,
  } as unknown as SandboxProvider;
}

// A store whose get() returns `text` for every digest, which is all these tests need — the
// mapping from digest to bytes is the blob store's own concern and is tested in that package.
function fakeStore(text: string | undefined) {
  return { put: vi.fn(), get: vi.fn(async () => (text === undefined ? undefined : encoder.encode(text))) };
}

describe("sanitiseDocumentName", () => {
  it("keeps an ordinary filename intact", () => {
    expect(sanitiseDocumentName("transcriber-retry-spec.md", 1)).toBe("transcriber-retry-spec.md");
  });

  it("strips directory components so a title cannot choose its own location", () => {
    expect(sanitiseDocumentName("../../etc/passwd", 1)).toBe("passwd");
    expect(sanitiseDocumentName("a/b/c/spec.md", 1)).toBe("spec.md");
  });

  it("strips leading dots so a document cannot land as a hidden file", () => {
    expect(sanitiseDocumentName(".gitignore", 1)).toBe("gitignore");
    expect(sanitiseDocumentName("..", 1)).toBe("document-1");
  });

  it("collapses everything outside the allowlist", () => {
    expect(sanitiseDocumentName("my spec (v2)!.md", 1)).toBe("my-spec-v2-.md");
  });

  it("falls back to the item id when nothing survives", () => {
    expect(sanitiseDocumentName("", 42)).toBe("document-42");
    expect(sanitiseDocumentName("???", 42)).toBe("document-42");
  });
});

describe("materialiseTaskDocuments", () => {
  it("writes every indexed document under the context directory", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([
      item({ id: 1, title: "transcriber-retry-spec.md" }),
      item({ id: 2, title: "notes.md" }),
    ]);
    const writeFiles = vi.fn();
    const provider = fakeSandbox({ writeFiles });

    const result = await materialiseTaskDocuments(provider, "sbx", 70, 1, {
      blobStore: fakeStore("# spec"),
    });

    expect(result.written).toEqual([
      `${TASK_DOCUMENT_DIR}/transcriber-retry-spec.md`,
      `${TASK_DOCUMENT_DIR}/notes.md`,
    ]);
    expect(result.omitted).toEqual([]);
    expect(writeFiles).toHaveBeenCalledWith("sbx", {
      [`${TASK_DOCUMENT_DIR}/transcriber-retry-spec.md`]: "# spec",
      [`${TASK_DOCUMENT_DIR}/notes.md`]: "# spec",
    });
  });

  it("creates the directory before writing into it", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([item({ id: 1, title: "spec.md" })]);
    const exec = vi.fn(async function* (): AsyncGenerator<OutputChunk> {});
    const provider = fakeSandbox({ exec });

    await materialiseTaskDocuments(provider, "sbx", 70, 1, { blobStore: fakeStore("x") });

    expect(exec).toHaveBeenCalledWith("sbx", ["mkdir", "-p", `/workspace/${TASK_DOCUMENT_DIR}`]);
  });

  it("skips documents that are not indexed yet", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([
      item({ id: 1, title: "ready.md", status: "indexed" }),
      item({ id: 2, title: "pending.md", status: "pending" }),
      item({ id: 3, title: "broken.md", status: "failed" }),
    ]);
    const provider = fakeSandbox();

    const result = await materialiseTaskDocuments(provider, "sbx", 70, 1, { blobStore: fakeStore("x") });

    expect(result.written).toEqual([`${TASK_DOCUMENT_DIR}/ready.md`]);
  });

  it("writes nothing and touches no sandbox when the task has no indexed documents", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([item({ id: 1, title: "pending.md", status: "pending" })]);
    const writeFiles = vi.fn();
    const exec = vi.fn(async function* (): AsyncGenerator<OutputChunk> {});
    const provider = fakeSandbox({ writeFiles, exec });

    const result = await materialiseTaskDocuments(provider, "sbx", 70, 1, { blobStore: fakeStore("x") });

    expect(result).toEqual({ written: [], omitted: [] });
    expect(writeFiles).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("de-duplicates filenames rather than silently overwriting", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([
      item({ id: 1, title: "spec.md" }),
      item({ id: 2, title: "spec.md" }),
      item({ id: 3, title: "spec.md" }),
    ]);
    const provider = fakeSandbox();

    const result = await materialiseTaskDocuments(provider, "sbx", 70, 1, { blobStore: fakeStore("x") });

    expect(result.written).toEqual([
      `${TASK_DOCUMENT_DIR}/spec.md`,
      `${TASK_DOCUMENT_DIR}/spec-2.md`,
      `${TASK_DOCUMENT_DIR}/spec-3.md`,
    ]);
  });

  it("omits a document that would exceed the total budget but keeps smaller ones behind it", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([
      item({ id: 1, title: "huge.md", sizeBytes: TASK_DOCUMENTS_BUDGET_BYTES + 1 }),
      item({ id: 2, title: "small.md", sizeBytes: 10 }),
    ]);
    const provider = fakeSandbox();

    const result = await materialiseTaskDocuments(provider, "sbx", 70, 1, { blobStore: fakeStore("x") });

    expect(result.written).toEqual([`${TASK_DOCUMENT_DIR}/small.md`]);
    expect(result.omitted).toEqual(["huge.md"]);
  });

  it("reports a document whose blob has gone missing rather than failing the run", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([item({ id: 1, title: "spec.md" })]);
    const writeFiles = vi.fn();
    const provider = fakeSandbox({ writeFiles });

    const result = await materialiseTaskDocuments(provider, "sbx", 70, 1, { blobStore: fakeStore(undefined) });

    expect(result).toEqual({ written: [], omitted: ["spec.md"] });
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it("degrades to an empty result when the database lookup throws", async () => {
    listTaskContextItemsForOrgMock.mockRejectedValue(new Error("db is down"));
    const provider = fakeSandbox();

    await expect(
      materialiseTaskDocuments(provider, "sbx", 70, 1, { blobStore: fakeStore("x") }),
    ).resolves.toEqual({ written: [], omitted: [] });
  });

  it("degrades to an empty result when writing into the sandbox throws", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([item({ id: 1, title: "spec.md" })]);
    const provider = fakeSandbox({
      writeFiles: vi.fn().mockRejectedValue(new Error("no such container")),
    });

    await expect(
      materialiseTaskDocuments(provider, "sbx", 70, 1, { blobStore: fakeStore("x") }),
    ).resolves.toEqual({ written: [], omitted: [] });
  });

  it("scopes the blob lookup to the run's own org", async () => {
    listTaskContextItemsForOrgMock.mockResolvedValue([item({ id: 1, title: "spec.md", sha256: "a".repeat(64) })]);
    const store = fakeStore("x");
    const provider = fakeSandbox();

    await materialiseTaskDocuments(provider, "sbx", 70, 7, { blobStore: store });

    expect(listTaskContextItemsForOrgMock).toHaveBeenCalledWith(70, 7);
    expect(store.get).toHaveBeenCalledWith(7, "a".repeat(64));
  });
});

// The claim these tests exist for is behavioural, and it is the one that decides whether a user's
// pull request comes out clean: pushChangesIfDirty (scm-provider.ts:314-318) treats a non-empty
// `git status --porcelain` as "there is something to push" and then runs `git add -A`. String
// assertions on the clone script cannot show that the pattern actually silences git, so these run
// real git against a real repository.
describe("TASK_DOCUMENT_EXCLUDE_PATTERN against real git", () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // `-C dir` alone isn't enough to isolate these from the repo actually running the test suite:
  // when this file runs from .husky/pre-push, git has already set GIT_DIR (and friends) in the
  // process env for the push it's hooking, and those env vars override `-C`'s repository
  // discovery for every child git process — silently redirecting these commits into the real
  // repo instead of the freshly `git init`'d temp dir. Scrub them so each helper repo is genuinely
  // self-contained regardless of what invoked the test run.
  function git(dir: string, ...args: string[]): string {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_OBJECT_DIRECTORY;
    delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  }

  // A checkout with one committed file and a clean tree — the state a run starts from.
  function repoWithCommit(): string {
    const dir = mkdtempSync(join(tmpdir(), "agentfactory-exclude-"));
    repos.push(dir);
    git(dir, "init", "--quiet");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test");
    writeFileSync(join(dir, "README.md"), "# repo\n");
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "initial");
    return dir;
  }

  function writeTaskDocument(dir: string, relativeDir = TASK_DOCUMENT_DIR): void {
    mkdirSync(join(dir, relativeDir), { recursive: true });
    writeFileSync(join(dir, relativeDir, "spec.md"), "# attached spec\n");
  }

  function excludeTaskDocuments(dir: string): void {
    appendFileSync(join(dir, ".git", "info", "exclude"), `${TASK_DOCUMENT_EXCLUDE_PATTERN}\n`);
  }

  it("is anchored to the checkout root", () => {
    expect(TASK_DOCUMENT_EXCLUDE_PATTERN.startsWith("/")).toBe(true);
    expect(TASK_DOCUMENT_EXCLUDE_PATTERN).toBe(`/${TASK_DOCUMENT_DIR.split("/")[0]}/`);
  });

  // Without the exclude this is exactly the bug: attaching a document makes a run that changed
  // nothing look dirty, so the platform commits and pushes it.
  it("without it, a materialised document makes a clean checkout look dirty", () => {
    const dir = repoWithCommit();
    writeTaskDocument(dir);

    expect(git(dir, "status", "--porcelain").trim()).not.toBe("");
  });

  it("with it, a materialised document leaves the checkout clean", () => {
    const dir = repoWithCommit();
    excludeTaskDocuments(dir);
    writeTaskDocument(dir);

    expect(git(dir, "status", "--porcelain").trim()).toBe("");
  });

  it("survives `git add -A`, which is what actually stages the agent's work", () => {
    const dir = repoWithCommit();
    excludeTaskDocuments(dir);
    writeTaskDocument(dir);

    git(dir, "add", "-A");

    expect(git(dir, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("does not swallow a real source change made alongside the documents", () => {
    const dir = repoWithCommit();
    excludeTaskDocuments(dir);
    writeTaskDocument(dir);
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");

    git(dir, "add", "-A");

    expect(git(dir, "diff", "--cached", "--name-only").trim()).toBe("src.ts");
  });

  // The anchor matters: a repository that happens to have its own .agentfactory/ directory
  // somewhere in its tree must keep it, or we would silently drop the user's own files.
  it("ignores only the checkout root, not a same-named directory nested in the repo", () => {
    const dir = repoWithCommit();
    excludeTaskDocuments(dir);
    writeTaskDocument(dir, join("src", ".agentfactory", "context"));

    git(dir, "add", "-A");

    expect(git(dir, "diff", "--cached", "--name-only").trim()).toBe("src/.agentfactory/context/spec.md");
  });

  // .git/info/exclude is per-clone and never committed. A .gitignore would itself show up in the
  // diff, which is the whole reason this mechanism was chosen over one.
  it("leaves nothing behind in the tree that could reach a pull request", () => {
    const dir = repoWithCommit();
    excludeTaskDocuments(dir);
    writeTaskDocument(dir);

    git(dir, "add", "-A");

    expect(git(dir, "ls-files").trim()).toBe("README.md");
  });
});
