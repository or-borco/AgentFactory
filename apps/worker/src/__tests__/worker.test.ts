import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@agentfactory/core";

const h = vi.hoisted(() => {
  const workers: Array<{ name: string; processor: (job: { data: unknown }) => Promise<unknown> }> = [];
  const sandbox = {
    create: vi.fn(async () => ({ id: "new-sandbox" })),
    exec: vi.fn(),
    writeFiles: vi.fn(),
    readWorkspace: vi.fn(async () => ({})),
    destroy: vi.fn(),
    exists: vi.fn(async () => true),
    resetMemory: vi.fn(),
  };
  return { workers, sandbox };
});

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      h.workers.push({ name, processor });
    }
    on() {}
  },
  Queue: class {
    add() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@agentfactory/queue", () => ({
  RUN_QUEUE_NAME: "runs",
  RUN_CANCEL_QUEUE_NAME: "run-cancel",
  SANDBOX_TEARDOWN_QUEUE_NAME: "sandbox-teardown",
  SANDBOX_REAP_QUEUE_NAME: "sandbox-reap",
  REPO_MAP_WARM_QUEUE_NAME: "repo-map-warm",
  EVAL_QUEUE_NAME: "evals",
  MEMORY_RETROSPECTIVE_QUEUE_NAME: "memory-retrospective",
  TEAM_CONTEXT_INGEST_QUEUE_NAME: "team-context-ingest",
  TASK_CONTEXT_INGEST_QUEUE_NAME: "task-context-ingest",
  queueConnection: {},
}));

const setSessionSandboxMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  clearSessionSandbox: vi.fn(),
  createEvent: vi.fn(),
  createMessage: vi.fn(),
  createPendingPrReview: vi.fn(),
  findSimilarMemoryEntry: vi.fn(),
  getAgent: vi.fn(),
  getCodebaseSettings: vi.fn(async () => undefined),
  getLatestPrReview: vi.fn(async () => undefined),
  getLatestResumeCandidate: vi.fn(async () => undefined),
  getMessage: vi.fn(),
  getRun: vi.fn(),
  getSession: vi.fn(),
  getTaskBySessionId: vi.fn(async () => undefined),
  getTeamForOrg: vi.fn(async () => undefined),
  hasNonTerminalRun: vi.fn(async () => false),
  insertMemoryEntry: vi.fn(),
  insertRunContextRetrievals: vi.fn(),
  listMessages: vi.fn(async () => []),
  readAgentMemoryEntries: vi.fn(async () => []),
  reinforceMemoryEntry: vi.fn(),
  setSessionSandbox: (...args: unknown[]) => setSessionSandboxMock(...args),
  touchSessionActivity: vi.fn(),
  updateRunCommitRange: vi.fn(),
  updateRunStatus: vi.fn(),
  updateRunWorkspace: vi.fn(),
  updateTask: vi.fn(),
}));

vi.mock("@agentfactory/scm", () => ({
  parsePullRequestReferenceAcrossProviders: vi.fn(() => undefined),
  resolveScmConnection: vi.fn(),
}));

vi.mock("../sandbox/docker-sandbox-provider", () => ({
  DockerSandboxProvider: class {
    create = h.sandbox.create;
    exec = h.sandbox.exec;
    writeFiles = h.sandbox.writeFiles;
    readWorkspace = h.sandbox.readWorkspace;
    destroy = h.sandbox.destroy;
    exists = h.sandbox.exists;
    resetMemory = h.sandbox.resetMemory;
  },
}));

vi.mock("../agent-runtime/registry", () => ({
  getAgentRuntime: () => ({
    kind: "claude-code",
    capabilities: () => ({ supportsSkills: true, skillDir: ".claude/skills", supportsResume: true }),
    runTurn: vi.fn(),
  }),
}));

const resolveSandboxImageMock = vi.fn();
vi.mock("../sandbox-image-select", () => ({
  resolveSandboxImage: (...args: unknown[]) => resolveSandboxImageMock(...args),
  SANDBOX_IMAGE_NODE: "arata-sandbox-node:local",
}));

vi.mock("../pr-review", async () => {
  const actual = await vi.importActual<typeof import("../pr-review")>("../pr-review");
  return { ...actual, checkoutPullRequest: vi.fn(), isAncestor: vi.fn(async () => false) };
});

vi.mock("../scm-provider", () => ({
  buildPullRequestBody: vi.fn(() => ""),
  cloneIntoSandbox: vi.fn(),
  fetchIssue: vi.fn(),
  openDraftPullRequest: vi.fn(),
  parseIssueReference: vi.fn(() => undefined),
  pushChangesIfDirty: vi.fn(async () => ({ changedFiles: [], pushed: false })),
  resolveCloneTarget: vi.fn(),
  sessionBranchName: vi.fn(() => "agent/session-1"),
  syncWithDefaultBranch: vi.fn(async () => ({ status: "up_to_date" })),
}));

vi.mock("../repo-map", () => ({ ensureRepoMap: vi.fn(async () => ""), warmRepoMap: vi.fn() }));
vi.mock("../context-retrieval", () => ({
  buildRetrievalQuery: vi.fn(() => ""),
  retrieveContext: vi.fn(async () => ({ text: "", retrievals: [] })),
}));
vi.mock("../context-ingest-wait", () => ({ waitForPendingContextIngest: vi.fn(async () => undefined) }));
vi.mock("../task-documents", () => ({ materialiseTaskDocuments: vi.fn(async () => ({ written: [], omitted: [] })) }));
vi.mock("../skills-materialize", () => ({ materialiseSkills: vi.fn(async () => []) }));
vi.mock("../eval-runner", () => ({ processEvalJob: vi.fn() }));
vi.mock("../memory-retrospective", () => ({ processMemoryRetrospectiveJob: vi.fn() }));
vi.mock("../context-ingest", () => ({ ingestTaskContextItem: vi.fn(), ingestTeamContextItem: vi.fn() }));
vi.mock("../task-notify", () => ({ notifyIssueOfPullRequest: vi.fn() }));
vi.mock("../sandbox-reap", () => ({ SANDBOX_REAP_INTERVAL_MS: 60_000, scanForIdleSandboxes: vi.fn() }));

const { ensureSandbox } = await import("../worker");

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 10,
    agentId: 20,
    title: "Session",
    origin: "web",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ensureSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.sandbox.exists.mockResolvedValue(true);
    h.sandbox.create.mockResolvedValue({ id: "new-sandbox" });
    h.sandbox.destroy.mockResolvedValue(undefined);
  });

  it("creates a sandbox with the resolved image and persists it when the session has none yet", async () => {
    const session = fakeSession({ sandboxId: undefined, sandboxImage: undefined });
    resolveSandboxImageMock.mockResolvedValue("arata-sandbox-python:local");

    const sandboxId = await ensureSandbox(session, 5, "acme/widgets", "acme/widgets");

    expect(sandboxId).toBe("new-sandbox");
    expect(resolveSandboxImageMock).toHaveBeenCalledWith(5, "acme/widgets");
    expect(h.sandbox.create).toHaveBeenCalledWith({ image: "arata-sandbox-python:local", env: expect.any(Object), volumes: [expect.objectContaining({ name: expect.stringMatching(/^arata-deps-cache-org-5-acme-widgets-[0-9a-f]{12}$/), target: "/cache" })] });
    expect(setSessionSandboxMock).toHaveBeenCalledWith(10, "new-sandbox", "arata-sandbox-python:local");
  });

  it("reuses an already language-specific sandbox without re-resolving the image", async () => {
    const session = fakeSession({ sandboxId: "existing-sandbox", sandboxImage: "arata-sandbox-python:local" });

    const sandboxId = await ensureSandbox(session, 5, "acme/widgets");

    expect(sandboxId).toBe("existing-sandbox");
    expect(resolveSandboxImageMock).not.toHaveBeenCalled();
    expect(h.sandbox.create).not.toHaveBeenCalled();
    expect(h.sandbox.destroy).not.toHaveBeenCalled();
    expect(setSessionSandboxMock).not.toHaveBeenCalled();
  });

  it("reuses a still-base-image sandbox as-is when re-resolution still returns the base image", async () => {
    const session = fakeSession({ sandboxId: "existing-sandbox", sandboxImage: "arata-sandbox-node:local" });
    resolveSandboxImageMock.mockResolvedValue("arata-sandbox-node:local");

    const sandboxId = await ensureSandbox(session, 5, undefined);

    expect(sandboxId).toBe("existing-sandbox");
    expect(resolveSandboxImageMock).toHaveBeenCalledWith(5, undefined);
    expect(h.sandbox.create).not.toHaveBeenCalled();
    expect(h.sandbox.destroy).not.toHaveBeenCalled();
    expect(setSessionSandboxMock).not.toHaveBeenCalled();
  });

  it("destroys and recreates a base-image sandbox once the repo's language becomes known", async () => {
    const session = fakeSession({ sandboxId: "existing-sandbox", sandboxImage: "arata-sandbox-node:local" });
    resolveSandboxImageMock.mockResolvedValue("arata-sandbox-java:local");
    h.sandbox.create.mockResolvedValue({ id: "upgraded-sandbox" });

    const sandboxId = await ensureSandbox(session, 5, "acme/widgets", "acme/widgets");

    expect(h.sandbox.destroy).toHaveBeenCalledWith("existing-sandbox");
    expect(h.sandbox.create).toHaveBeenCalledWith({ image: "arata-sandbox-java:local", env: expect.any(Object), volumes: [expect.objectContaining({ name: expect.stringMatching(/^arata-deps-cache-org-5-acme-widgets-[0-9a-f]{12}$/), target: "/cache" })] });
    expect(setSessionSandboxMock).toHaveBeenCalledWith(10, "upgraded-sandbox", "arata-sandbox-java:local");
    expect(sandboxId).toBe("upgraded-sandbox");
  });

  it("mounts no dependency cache for a sandbox without a cache repo, such as a PR review", async () => {
    const session = fakeSession();
    resolveSandboxImageMock.mockResolvedValue("arata-sandbox-node:local");

    await ensureSandbox(session, 5, "acme/widgets");

    expect(h.sandbox.create).toHaveBeenCalledWith(expect.objectContaining({ volumes: [] }));
  });

  it("creates fresh when the session's stored sandboxId no longer exists", async () => {
    const session = fakeSession({ sandboxId: "gone-sandbox", sandboxImage: "arata-sandbox-python:local" });
    h.sandbox.exists.mockResolvedValue(false);
    resolveSandboxImageMock.mockResolvedValue("arata-sandbox-python:local");

    const sandboxId = await ensureSandbox(session, 5, "acme/widgets");

    expect(h.sandbox.destroy).not.toHaveBeenCalled();
    expect(h.sandbox.create).toHaveBeenCalledWith({ image: "arata-sandbox-python:local", env: expect.any(Object), volumes: [] });
    expect(setSessionSandboxMock).toHaveBeenCalledWith(10, "new-sandbox", "arata-sandbox-python:local");
    expect(sandboxId).toBe("new-sandbox");
  });
});
