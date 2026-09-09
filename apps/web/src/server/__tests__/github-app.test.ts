import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// signAppJwt() needs a real asymmetric key to actually sign with — irrelevant to what these
// tests check (the HTTP calls listInstallationRepos makes), so stub jsonwebtoken entirely.
vi.mock("jsonwebtoken", () => ({ default: { sign: vi.fn(() => "fake.app.jwt") } }));
vi.mock("@agentfactory/db", () => ({ listConnections: vi.fn() }));

import { listConnections } from "@agentfactory/db";
import { dedupeRepos, listInstallationRepos } from "../github-app";

describe("listInstallationRepos", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("mints an installation token then lists repos with it, mapped to a smaller shape", async () => {
    const fetchMock = vi
      .fn()
      // token mint
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "ghs_abc", expires_at: "2026-01-01T00:00:00Z" }), { status: 200 }),
      )
      // repo list
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            repositories: [
              { id: 1, full_name: "acme-org/platform", private: true },
              { id: 2, full_name: "acme-org/docs", private: false },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const repos = await listInstallationRepos(999);

    expect(repos).toEqual([
      { id: 1, fullName: "acme-org/platform", private: true },
      { id: 2, fullName: "acme-org/docs", private: false },
    ]);
    const [, listCall] = fetchMock.mock.calls;
    expect(listCall[0]).toBe("https://api.github.com/installation/repositories?per_page=100");
    expect(listCall[1].headers.Authorization).toBe("Bearer ghs_abc");
  });

  it("throws when GitHub responds with an error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "ghs_abc", expires_at: "2026-01-01T00:00:00Z" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listInstallationRepos(999)).rejects.toThrow("/installation/repositories failed: 404");
  });
});

describe("dedupeRepos", () => {
  it("flattens multiple installations' repo lists", () => {
    const merged = dedupeRepos([
      [{ id: 1, fullName: "acme-org/platform", private: true }],
      [{ id: 2, fullName: "other-org/site", private: false }],
    ]);
    expect(merged).toEqual([
      { id: 1, fullName: "acme-org/platform", private: true },
      { id: 2, fullName: "other-org/site", private: false },
    ]);
  });

  it("dedupes repos that appear in more than one installation's list", () => {
    const repo = { id: 1, fullName: "acme-org/platform", private: true };
    const merged = dedupeRepos([[repo], [repo]]);
    expect(merged).toEqual([repo]);
  });

  it("returns an empty array when there are no connections", () => {
    expect(dedupeRepos([])).toEqual([]);
  });
});

describe("findInstallationForRepo", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(listConnections).mockReset();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("returns the installation id whose repo list contains the target repo", async () => {
    vi.mocked(listConnections).mockResolvedValue([
      { id: 1, orgId: 1, provider: "github", config: { installationId: 111 } },
    ] as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repositories: [{ id: 1, full_name: "acme/widgets", private: false }] }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { findInstallationForRepo } = await import("../github-app");
    await expect(findInstallationForRepo(1, "acme/widgets")).resolves.toBe(111);
  });

  it("returns undefined when no connection's installation can see the repo", async () => {
    vi.mocked(listConnections).mockResolvedValue([
      { id: 1, orgId: 1, provider: "github", config: { installationId: 111 } },
    ] as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repositories: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { findInstallationForRepo } = await import("../github-app");
    await expect(findInstallationForRepo(1, "acme/widgets")).resolves.toBeUndefined();
  });

  it("ignores non-github connections and connections with no installationId", async () => {
    vi.mocked(listConnections).mockResolvedValue([
      { id: 1, orgId: 1, provider: "slack", config: {} },
      { id: 2, orgId: 1, provider: "github", config: {} },
    ] as never);

    const { findInstallationForRepo } = await import("../github-app");
    await expect(findInstallationForRepo(1, "acme/widgets")).resolves.toBeUndefined();
  });
});

describe("resolveDefaultBranchSha", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----\\n";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(listConnections).mockReset();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("resolves the default branch then its HEAD sha", async () => {
    vi.mocked(listConnections).mockResolvedValue([
      { id: 1, orgId: 1, provider: "github", config: { installationId: 111 } },
    ] as never);
    const fetchMock = vi
      .fn()
      // token mint (for findInstallationForRepo's listInstallationRepos call)
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" }), { status: 200 }))
      // installation repo list
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repositories: [{ id: 1, full_name: "acme/widgets", private: false }] }), {
          status: 200,
        }),
      )
      // token mint (for the repo/commit lookups)
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" }), { status: 200 }))
      // repo lookup -> default_branch
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
      // commit lookup -> sha
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: "deadbeef" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveDefaultBranchSha } = await import("../github-app");
    await expect(resolveDefaultBranchSha(1, "acme/widgets")).resolves.toBe("deadbeef");
  });

  it("returns undefined when no installation covers the repo", async () => {
    vi.mocked(listConnections).mockResolvedValue([]);

    const { resolveDefaultBranchSha } = await import("../github-app");
    await expect(resolveDefaultBranchSha(1, "acme/widgets")).resolves.toBeUndefined();
  });

  it("returns undefined when the repo lookup fails", async () => {
    vi.mocked(listConnections).mockResolvedValue([
      { id: 1, orgId: 1, provider: "github", config: { installationId: 111 } },
    ] as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repositories: [{ id: 1, full_name: "acme/widgets", private: false }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveDefaultBranchSha } = await import("../github-app");
    await expect(resolveDefaultBranchSha(1, "acme/widgets")).resolves.toBeUndefined();
  });

  it("returns undefined when the commit lookup fails", async () => {
    vi.mocked(listConnections).mockResolvedValue([
      { id: 1, orgId: 1, provider: "github", config: { installationId: 111 } },
    ] as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repositories: [{ id: 1, full_name: "acme/widgets", private: false }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_abc", expires_at: "x" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const { resolveDefaultBranchSha } = await import("../github-app");
    await expect(resolveDefaultBranchSha(1, "acme/widgets")).resolves.toBeUndefined();
  });
});
