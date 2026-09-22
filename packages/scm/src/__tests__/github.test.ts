import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import { ScmInstallIncompleteError } from "../types";
import { githubScmProvider } from "../github";

// signAppJwt() needs a real asymmetric key to actually sign with — irrelevant to what these
// tests check, so stub jsonwebtoken entirely.
vi.mock("jsonwebtoken", () => ({ default: { sign: vi.fn(() => "fake.app.jwt") } }));

function githubConnection(id: number, installationId: number): Connection {
  return {
    id,
    orgId: 1,
    provider: "github",
    kind: "scm",
    label: `installation-${installationId}`,
    health: "healthy",
    config: { installationId },
    auth: "none",
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_APP_SLUG;
});

describe("authorizeUrl", () => {
  it("builds the GitHub App install URL with the given state", () => {
    process.env.GITHUB_APP_SLUG = "agentfactory-dev";
    expect(githubScmProvider.authorizeUrl("abc123")).toBe(
      "https://github.com/apps/agentfactory-dev/installations/new?state=abc123",
    );
  });

  it("throws when GITHUB_APP_SLUG is not set", () => {
    delete process.env.GITHUB_APP_SLUG;
    expect(() => githubScmProvider.authorizeUrl("abc123")).toThrow("GITHUB_APP_SLUG is not set");
  });
});

describe("completeInstall", () => {
  it("throws ScmInstallIncompleteError('pending') when setupAction is 'request'", async () => {
    await expect(
      githubScmProvider.completeInstall({ setupAction: "request", installationId: "", state: "s" }),
    ).rejects.toMatchObject(new ScmInstallIncompleteError("pending"));
  });

  it("throws ScmInstallIncompleteError('missing_installation') when installationId is absent", async () => {
    await expect(
      githubScmProvider.completeInstall({ setupAction: "", installationId: "", state: "s" }),
    ).rejects.toMatchObject(new ScmInstallIncompleteError("missing_installation"));
  });

  it("resolves the installation and returns a label/config to persist as a Connection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 999, account: { login: "acme-org", type: "Organization" } }), {
          status: 200,
        }),
      ),
    );

    const result = await githubScmProvider.completeInstall({
      setupAction: "install",
      installationId: "999",
      state: "s",
    });

    expect(result).toEqual({
      label: "acme-org",
      config: { installationId: 999, accountLogin: "acme-org", accountType: "Organization" },
    });
  });

  it("falls back to a generic label when the installation has no account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 999, account: null }), { status: 200 })),
    );

    const result = await githubScmProvider.completeInstall({
      setupAction: "install",
      installationId: "999",
      state: "s",
    });

    expect(result.label).toBe("installation-999");
  });
});

describe("listRepos", () => {
  it("lists repos for the connection's installation, mapped to RepoRef", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              repositories: [
                { id: 1, full_name: "acme-org/platform" },
                { id: 2, full_name: "acme-org/docs" },
              ],
            }),
            { status: 200 },
          ),
        ),
    );

    const repos = await githubScmProvider.listRepos(githubConnection(1, 999));

    expect(repos).toEqual([
      { id: "1", fullName: "acme-org/platform" },
      { id: "2", fullName: "acme-org/docs" },
    ]);
  });

  it("returns an empty list when the connection has no installationId", async () => {
    const connection = { ...githubConnection(1, 999), config: {} };
    await expect(githubScmProvider.listRepos(connection)).resolves.toEqual([]);
  });
});

describe("findRepoAccess", () => {
  it("returns the connection whose installation can see the repo", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ repositories: [{ id: 1, full_name: "acme-org/platform" }] }), {
            status: 200,
          }),
        ),
    );

    const connection = githubConnection(1, 999);
    await expect(githubScmProvider.findRepoAccess([connection], "acme-org/platform")).resolves.toBe(connection);
  });

  it("skips connections with no installationId and returns undefined when none match", async () => {
    const noInstallation = { ...githubConnection(1, 999), config: {} };
    await expect(githubScmProvider.findRepoAccess([noInstallation], "acme-org/platform")).resolves.toBeUndefined();
  });

  it("skips a connection whose installation lookup fails and keeps checking others", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_list" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repositories: [{ id: 1, full_name: "acme-org/platform" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const second = githubConnection(2, 222);
    const result = await githubScmProvider.findRepoAccess([githubConnection(1, 111), second], "acme-org/platform");
    expect(result).toBe(second);
  });

  it("throws immediately when the app itself isn't configured, instead of reporting a misleading 'repo not accessible'", async () => {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubScmProvider.findRepoAccess([githubConnection(1, 999)], "acme-org/platform")).rejects.toThrow(
      "GITHUB_APP_PRIVATE_KEY is not set",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveCloneTarget", () => {
  it("returns a clone target with a fresh embedded token and a plain remote URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_clone" }), { status: 200 })));

    const target = await githubScmProvider.resolveCloneTarget(githubConnection(1, 999), "acme-org/platform", "agent/session-42");

    expect(target).toEqual({
      cloneUrl: "https://x-access-token:ghs_clone@github.com/acme-org/platform.git",
      remoteUrl: "https://github.com/acme-org/platform.git",
      branch: "agent/session-42",
      repoFullName: "acme-org/platform",
      provider: "github",
      installationRef: 999,
    });
  });

  it("throws when the connection has no installationId", async () => {
    const connection = { ...githubConnection(1, 999), config: {} };
    await expect(githubScmProvider.resolveCloneTarget(connection, "acme-org/platform", "b")).rejects.toThrow(
      "has no GitHub installationId",
    );
  });
});

describe("mintPushToken", () => {
  it("mints a fresh token from the target's installationRef", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_push" }), { status: 200 })));

    const target = {
      cloneUrl: "x",
      remoteUrl: "y",
      branch: "b",
      repoFullName: "acme-org/platform",
      provider: "github" as const,
      installationRef: 999,
    };
    await expect(githubScmProvider.mintPushToken(target)).resolves.toBe("ghs_push");
  });

  it("throws when installationRef is not a number", async () => {
    const target = {
      cloneUrl: "x",
      remoteUrl: "y",
      branch: "b",
      repoFullName: "acme-org/platform",
      provider: "github" as const,
      installationRef: "not-a-number",
    };
    await expect(githubScmProvider.mintPushToken(target)).rejects.toThrow("installationRef is not a GitHub installation id");
  });
});

describe("fetchIssue", () => {
  it("fetches the issue's title and body via the connection's installation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_issue" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ title: "Crash on startup", body: "Steps to reproduce..." }), { status: 200 }),
        ),
    );

    const issue = await githubScmProvider.fetchIssue(githubConnection(1, 999), "acme-org/platform", 37);
    expect(issue).toEqual({ title: "Crash on startup", body: "Steps to reproduce..." });
  });

  it("defaults a null body to an empty string", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_issue" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ title: "T", body: null }), { status: 200 })),
    );

    await expect(githubScmProvider.fetchIssue(githubConnection(1, 999), "acme-org/platform", 37)).resolves.toEqual({
      title: "T",
      body: "",
    });
  });

  it("throws when the issue lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_issue" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("not found", { status: 404 })),
    );

    await expect(githubScmProvider.fetchIssue(githubConnection(1, 999), "acme-org/platform", 37)).rejects.toThrow(
      "GitHub API issue fetch failed: 404",
    );
  });
});

describe("resolveDefaultBranchSha", () => {
  it("returns the default branch's HEAD sha", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_api" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "abc123" }), { status: 200 })),
    );

    await expect(githubScmProvider.resolveDefaultBranchSha(githubConnection(1, 999), "acme-org/platform")).resolves.toBe(
      "abc123",
    );
  });

  it("throws when the repo lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_api" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("not found", { status: 404 })),
    );
    await expect(
      githubScmProvider.resolveDefaultBranchSha(githubConnection(1, 999), "acme-org/platform"),
    ).rejects.toThrow("GitHub API repo lookup failed: 404");
  });

  it("throws when the commit lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_api" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("not found", { status: 404 })),
    );
    await expect(
      githubScmProvider.resolveDefaultBranchSha(githubConnection(1, 999), "acme-org/platform"),
    ).rejects.toThrow("GitHub API commit lookup failed: 404");
  });
});

describe("detectPrimaryLanguage", () => {
  it("returns the language with the highest byte count", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_api" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ Python: 48213, Dockerfile: 421 }), { status: 200 })),
    );

    await expect(githubScmProvider.detectPrimaryLanguage(githubConnection(1, 999), "acme-org/platform")).resolves.toBe(
      "Python",
    );
  });

  it("returns undefined for an empty languages map", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_api" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 })),
    );

    await expect(
      githubScmProvider.detectPrimaryLanguage(githubConnection(1, 999), "acme-org/platform"),
    ).resolves.toBeUndefined();
  });

  it("throws when the languages fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_api" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("not found", { status: 404 })),
    );

    await expect(
      githubScmProvider.detectPrimaryLanguage(githubConnection(1, 999), "acme-org/platform"),
    ).rejects.toThrow("GitHub API languages fetch failed: 404");
  });
});

describe("fetchCommitRangeDiff", () => {
  const target = {
    cloneUrl: "x",
    remoteUrl: "y",
    branch: "agent/session-12",
    repoFullName: "acme-org/platform",
    provider: "github" as const,
    installationRef: 999,
  };
  const RANGE = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };

  it("compares the two shas directly and returns the diff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_diff" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("diff --git a/x b/x\n+added\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubScmProvider.fetchCommitRangeDiff(target, RANGE)).resolves.toBe("diff --git a/x b/x\n+added\n");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/acme-org/platform/compare/${RANGE.baseSha}...${RANGE.headSha}`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ghs_diff", Accept: "application/vnd.github.v3.diff" }),
      }),
    );
  });

  it("returns an empty diff as a string, never undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_diff" }), { status: 200 })).mockResolvedValueOnce(new Response("", { status: 200 })),
    );
    await expect(githubScmProvider.fetchCommitRangeDiff(target, RANGE)).resolves.toBe("");
  });

  it("raises on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_diff" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("Not Found", { status: 404 })),
    );
    await expect(githubScmProvider.fetchCommitRangeDiff(target, RANGE)).rejects.toThrow(/compare failed: 404/);
  });
});

describe("openDraftPullRequest", () => {
  it("fetches the repo's default branch and opens a draft PR against it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_pr" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "develop" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ number: 7, html_url: "https://github.com/acme-org/platform/pull/7" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pr = await githubScmProvider.openDraftPullRequest(
      githubConnection(1, 999),
      "acme-org/platform",
      "agent/session-1",
      "Fix the bug",
      "body text",
    );

    expect(pr).toEqual({ number: 7, url: "https://github.com/acme-org/platform/pull/7" });
    const [, , prCall] = fetchMock.mock.calls;
    expect(prCall[0]).toBe("https://api.github.com/repos/acme-org/platform/pulls");
    expect(JSON.parse(prCall[1].body)).toEqual({
      title: "Fix the bug",
      head: "agent/session-1",
      base: "develop",
      body: "body text",
      draft: true,
    });
  });

  it("throws when PR creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_pr" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("unprocessable", { status: 422 })),
    );
    await expect(
      githubScmProvider.openDraftPullRequest(githubConnection(1, 999), "acme-org/platform", "agent/session-1", "t", "b"),
    ).rejects.toThrow("GitHub API PR creation failed: 422");
  });
});

describe("parseIssueReference", () => {
  it("extracts the repo and issue number from a github issue url", () => {
    expect(githubScmProvider.parseIssueReference("https://github.com/acme-org/platform/issues/37")).toEqual({
      repoFullName: "acme-org/platform",
      issueNumber: 37,
    });
  });

  it("finds the link even when it's embedded in surrounding text", () => {
    expect(githubScmProvider.parseIssueReference("Please review https://github.com/acme-org/platform/issues/8 today")).toEqual(
      { repoFullName: "acme-org/platform", issueNumber: 8 },
    );
  });

  it("returns undefined when there's no issue link", () => {
    expect(githubScmProvider.parseIssueReference("Add a retry button to the failed-run banner.")).toBeUndefined();
  });

  it("returns undefined for a pull request link", () => {
    expect(githubScmProvider.parseIssueReference("https://github.com/acme-org/platform/pull/37")).toBeUndefined();
  });
});

describe("fetchPullRequest", () => {
  it("fetches PR state/base/head/title/body and classifies merged separately from closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_pr" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              state: "closed",
              merged: true,
              base: { ref: "main" },
              head: { sha: "headsha123" },
              title: "Add widgets",
              body: "Adds the widgets feature.",
            }),
            { status: 200 },
          ),
        ),
    );

    const result = await githubScmProvider.fetchPullRequest(githubConnection(1, 999), "acme-org/platform", 42);

    expect(result).toEqual({
      state: "merged",
      baseBranch: "main",
      headSha: "headsha123",
      title: "Add widgets",
      body: "Adds the widgets feature.",
    });
  });

  it("treats a null body as an empty string", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_pr" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              state: "open",
              merged: false,
              base: { ref: "main" },
              head: { sha: "headsha123" },
              title: "Add widgets",
              body: null,
            }),
            { status: 200 },
          ),
        ),
    );

    const result = await githubScmProvider.fetchPullRequest(githubConnection(1, 999), "acme-org/platform", 42);
    expect(result.body).toBe("");
    expect(result.state).toBe("open");
  });
});

describe("fetchReviewThreads", () => {
  it("maps the GitHub review-comments list to ReviewComment[]", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_comments" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              { path: "src/a.ts", line: 10, body: "consider a null check", user: { login: "agentfactory[bot]" }, created_at: "2026-09-14T00:00:00Z" },
              { path: "src/b.ts", line: null, original_line: 5, body: "fixed", user: { login: "alice" }, created_at: "2026-09-14T01:00:00Z" },
            ]),
            { status: 200 },
          ),
        ),
    );

    const threads = await githubScmProvider.fetchReviewThreads(githubConnection(1, 999), "acme-org/platform", 42);

    expect(threads).toEqual([
      { path: "src/a.ts", line: 10, body: "consider a null check", author: "agentfactory[bot]", createdAt: "2026-09-14T00:00:00Z" },
      { path: "src/b.ts", line: 5, body: "fixed", author: "alice", createdAt: "2026-09-14T01:00:00Z" },
    ]);
  });
});

describe("fetchPullRequestFeedback", () => {
  // The three list calls run concurrently, so the fake routes by URL rather than call order.
  function routedFetch(routes: Record<string, Response | Response[]>) {
    return vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_feedback" }), { status: 200 });
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected fetch ${url}`);
      const route = routes[key];
      return Array.isArray(route) ? (route.shift() as Response) : route;
    });
  }

  it("merges conversation comments, non-empty reviews, and inline comments, oldest first", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "/issues/42/comments": new Response(
          JSON.stringify([{ body: "Don't use code comments", user: { login: "or" }, created_at: "2026-09-22T20:36:00Z" }]),
          { status: 200 },
        ),
        "/pulls/42/reviews": new Response(
          JSON.stringify([
            { body: "", user: { login: "bob" }, state: "APPROVED", submitted_at: "2026-09-22T20:30:00Z" },
            { body: "Needs work", user: { login: "or" }, state: "CHANGES_REQUESTED", submitted_at: "2026-09-22T20:35:00Z" },
          ]),
          { status: 200 },
        ),
        "/pulls/42/comments": new Response(
          JSON.stringify([
            { path: "src/a.tsx", line: null, original_line: 7, body: "extract styles", user: { login: "or" }, created_at: "2026-09-22T20:34:00Z" },
          ]),
          { status: 200 },
        ),
      }),
    );

    const feedback = await githubScmProvider.fetchPullRequestFeedback(githubConnection(1, 999), "acme-org/platform", 42);

    expect(feedback).toEqual([
      { kind: "inline", author: "or", body: "extract styles", createdAt: "2026-09-22T20:34:00Z", path: "src/a.tsx", line: 7 },
      { kind: "review", author: "or", body: "Needs work", createdAt: "2026-09-22T20:35:00Z", reviewState: "CHANGES_REQUESTED" },
      { kind: "conversation", author: "or", body: "Don't use code comments", createdAt: "2026-09-22T20:36:00Z" },
    ]);
  });

  it("follows the Link header to later pages", async () => {
    const nextUrl = "https://api.github.com/repos/acme-org/platform/issues/42/comments?per_page=100&page=2";
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "/issues/42/comments": [
          new Response(JSON.stringify([{ body: "one", user: { login: "a" }, created_at: "2026-09-22T00:00:01Z" }]), {
            status: 200,
            headers: { link: `<${nextUrl}>; rel="next", <${nextUrl}>; rel="last"` },
          }),
          new Response(JSON.stringify([{ body: "two", user: { login: "a" }, created_at: "2026-09-22T00:00:02Z" }]), {
            status: 200,
          }),
        ],
        "/pulls/42/reviews": new Response("[]", { status: 200 }),
        "/pulls/42/comments": new Response("[]", { status: 200 }),
      }),
    );

    const feedback = await githubScmProvider.fetchPullRequestFeedback(githubConnection(1, 999), "acme-org/platform", 42);

    expect(feedback.map((c) => c.body)).toEqual(["one", "two"]);
  });

  it("throws with the status when any list call fails", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "/issues/42/comments": new Response("[]", { status: 200 }),
        "/pulls/42/reviews": new Response("nope", { status: 403 }),
        "/pulls/42/comments": new Response("[]", { status: 200 }),
      }),
    );

    await expect(
      githubScmProvider.fetchPullRequestFeedback(githubConnection(1, 999), "acme-org/platform", 42),
    ).rejects.toThrow(/reviews failed: 403/);
  });
});

describe("postReview", () => {
  const review: import("../types").ReviewToPost = {
    summary: "Looks solid overall.",
    verdict: "comment",
    comments: [{ path: "src/a.ts", line: 12, body: "nit: rename this" }],
  };

  it("posts a COMMENT review as requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_review" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 555, html_url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555" }), { status: 200 })),
    );

    const result = await githubScmProvider.postReview(githubConnection(1, 999), "acme-org/platform", 42, review);

    expect(result).toEqual({
      id: "555",
      url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
      postedAs: "comment",
    });
  });

  it("posts REQUEST_CHANGES as requested when it succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_review" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 556, html_url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-556" }), { status: 200 })),
    );

    const result = await githubScmProvider.postReview(githubConnection(1, 999), "acme-org/platform", 42, {
      ...review,
      verdict: "request_changes",
    });

    expect(result.postedAs).toBe("request_changes");
  });

  it("falls back to a COMMENT with a warning header when GitHub rejects REQUEST_CHANGES on the app's own PR", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_review" }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "Can not request changes on your own pull request" }), { status: 422 }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: 557, html_url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-557" }), { status: 200 })),
    );

    const result = await githubScmProvider.postReview(githubConnection(1, 999), "acme-org/platform", 42, {
      ...review,
      verdict: "request_changes",
    });

    expect(result.postedAs).toBe("comment");
    const secondCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[2];
    const sentBody = JSON.parse(secondCall[1].body as string);
    expect(sentBody.event).toBe("COMMENT");
    expect(sentBody.body).toMatch(/^⛔ Changes requested/);
  });

  it("throws on a non-422 failure without attempting the fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_review" }), { status: 200 }))
        .mockResolvedValueOnce(new Response("server error", { status: 500 })),
    );

    await expect(
      githubScmProvider.postReview(githubConnection(1, 999), "acme-org/platform", 42, { ...review, verdict: "request_changes" }),
    ).rejects.toThrow(/GitHub API review post failed/);
  });
});

describe("parsePullRequestReference", () => {
  it("parses a github.com PR URL", () => {
    expect(githubScmProvider.parsePullRequestReference("please review https://github.com/acme/widgets/pull/42 thanks")).toEqual({
      repoFullName: "acme/widgets",
      prNumber: 42,
    });
  });

  it("returns undefined when there is no PR link", () => {
    expect(githubScmProvider.parsePullRequestReference("just a normal task description")).toBeUndefined();
  });

  it("returns the first match when there is more than one PR link", () => {
    expect(
      githubScmProvider.parsePullRequestReference(
        "see also https://github.com/acme/widgets/pull/10 but review https://github.com/acme/widgets/pull/42",
      ),
    ).toEqual({ repoFullName: "acme/widgets", prNumber: 10 });
  });
});
