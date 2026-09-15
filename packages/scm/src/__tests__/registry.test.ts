import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import type { ScmProvider } from "../types";

const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
vi.mock("@agentfactory/db", () => ({ listConnections: (orgId: number) => listConnectionsMock(orgId) }));

// Mock github module to avoid needing GITHUB_APP_ID during tests
vi.mock("../github", () => ({
  githubScmProvider: {
    id: "github",
    authorizeUrl: () => "",
    completeInstall: async () => ({ label: "", config: {} }),
    listRepos: async () => [],
    async findRepoAccess() {
      return undefined;
    },
    resolveCloneTarget: async () => "",
    mintPushToken: async () => "",
    fetchIssue: async () => ({ number: 1, title: "", body: "", state: "open" }),
    resolveDefaultBranchSha: async () => "",
    fetchCommitRangeDiff: async () => "",
    openDraftPullRequest: async () => ({ url: "" }),
    parseIssueReference: (text: string) => {
      // Simple GitHub URL parser for testing
      const match = text.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
      if (match) {
        return { repoFullName: `${match[1]}/${match[2]}`, issueNumber: parseInt(match[3], 10) };
      }
      return undefined;
    },
  },
}));

const { providers, getScmProvider, resolveScmConnection, parseIssueReferenceAcrossProviders } = await import(
  "../registry"
);

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

afterEach(() => {
  providers.length = 1; // drop any stub provider a test registered, keep githubScmProvider
  listConnectionsMock.mockReset();
});

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
