import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import type { ScmProvider } from "../types";

const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
vi.mock("@agentfactory/db", () => ({ listConnections: (orgId: number) => listConnectionsMock(orgId) }));

// jsonwebtoken is mocked to avoid needing a real asymmetric key for tests
vi.mock("jsonwebtoken", () => ({ default: { sign: vi.fn(() => "fake.app.jwt") } }));

const {
  providers,
  getScmProvider,
  resolveScmConnection,
  parseIssueReferenceAcrossProviders,
  parsePullRequestReferenceAcrossProviders,
} = await import("../registry");

beforeEach(() => {
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_APP_SLUG;
  providers.length = 1; // drop any stub provider a test registered, keep githubScmProvider
  listConnectionsMock.mockReset();
});

function stubBitbucketProvider(): ScmProvider & { seenConnections: Connection[][] } {
  const seenConnections: Connection[][] = [];
  return {
    id: "bitbucket",
    seenConnections,
    authorizeUrl: () => "",
    completeInstall: async () => ({ label: "", config: {} }),
    listRepos: async () => [],
    async findRepoAccess(connections, repoFullName) {
      seenConnections.push(connections);
      return connections.find((c) => c.config.repo === repoFullName);
    },
    resolveCloneTarget: async () => {
      throw new Error("not implemented");
    },
    mintPushToken: async () => "",
    fetchIssue: async () => {
      throw new Error("not implemented");
    },
    resolveDefaultBranchSha: async () => "",
    fetchCommitRangeDiff: async () => "",
    openDraftPullRequest: async () => {
      throw new Error("not implemented");
    },
    parseIssueReference: () => undefined,
    fetchPullRequest: async () => {
      throw new Error("not implemented");
    },
    fetchReviewThreads: async () => {
      throw new Error("not implemented");
    },
    postReview: async () => {
      throw new Error("not implemented");
    },
    parsePullRequestReference: () => undefined,
  };
}

function connection(id: number, provider: "github" | "bitbucket", config: Record<string, unknown> = {}): Connection {
  return {
    id,
    orgId: 1,
    provider,
    kind: "scm",
    label: provider,
    health: "healthy",
    config,
    auth: "none",
    createdAt: new Date().toISOString(),
  };
}

describe("resolveScmConnection", () => {
  it("tries providers in registration order and returns the first match", async () => {
    providers.push(stubBitbucketProvider());
    listConnectionsMock.mockResolvedValue([connection(1, "bitbucket", { repo: "acme/widgets" })]);

    const resolved = await resolveScmConnection(1, "acme/widgets");

    expect(resolved?.provider.id).toBe("bitbucket");
    expect(resolved?.connection.provider).toBe("bitbucket");
  });

  it("returns undefined when no registered provider's connections match", async () => {
    providers.push(stubBitbucketProvider());
    listConnectionsMock.mockResolvedValue([connection(1, "bitbucket", { repo: "other/repo" })]);

    await expect(resolveScmConnection(1, "acme/widgets")).resolves.toBeUndefined();
  });

  it("only ever hands a provider its own connections, never another provider's", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ repositories: [] }), { status: 200 })),
    );

    const bitbucket = stubBitbucketProvider();
    providers.push(bitbucket);
    listConnectionsMock.mockResolvedValue([
      connection(1, "github", { installationId: 999 }),
      connection(2, "bitbucket", { repo: "acme/widgets" }),
    ]);

    await resolveScmConnection(1, "acme/widgets");

    expect(bitbucket.seenConnections).toHaveLength(1);
    expect(bitbucket.seenConnections[0]).toHaveLength(1);
    expect(bitbucket.seenConnections[0][0].config).toEqual({ repo: "acme/widgets" });
  });

  it("ignores non-scm connections", async () => {
    listConnectionsMock.mockResolvedValue([{ ...connection(1, "github"), kind: "tasks" }]);
    await expect(resolveScmConnection(1, "acme/widgets")).resolves.toBeUndefined();
  });
});

describe("getScmProvider", () => {
  it("returns the registered provider by id", () => {
    expect(getScmProvider("github")?.id).toBe("github");
  });

  it("returns undefined for an id with no registered provider", () => {
    expect(getScmProvider("bitbucket")).toBeUndefined();
  });
});

describe("parseIssueReferenceAcrossProviders", () => {
  it("returns the matching provider's result tagged with its id", () => {
    expect(parseIssueReferenceAcrossProviders("https://github.com/acme/widgets/issues/12")).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 12,
      provider: "github",
    });
  });

  it("returns undefined when no registered provider recognizes the text", () => {
    expect(parseIssueReferenceAcrossProviders("no link here")).toBeUndefined();
  });
});

describe("parsePullRequestReferenceAcrossProviders", () => {
  it("returns the matching provider's result tagged with its id", () => {
    expect(parsePullRequestReferenceAcrossProviders("https://github.com/acme/widgets/pull/12")).toEqual({
      repoFullName: "acme/widgets",
      prNumber: 12,
      provider: "github",
    });
  });

  it("returns undefined when no registered provider recognizes the text", () => {
    expect(parsePullRequestReferenceAcrossProviders("no link here")).toBeUndefined();
  });

  it("tries providers in registration order and returns the first match", () => {
    const stub: ScmProvider = {
      ...stubBitbucketProvider(),
      parsePullRequestReference: (text) =>
        text === "bitbucket-pr-link" ? { repoFullName: "acme/widgets", prNumber: 99 } : undefined,
    };
    providers.push(stub);

    expect(parsePullRequestReferenceAcrossProviders("bitbucket-pr-link")).toEqual({
      repoFullName: "acme/widgets",
      prNumber: 99,
      provider: "bitbucket",
    });
  });
});
