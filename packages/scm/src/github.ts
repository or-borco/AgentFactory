import jwt from "jsonwebtoken";
import type { Connection } from "@agentfactory/core";
import { ScmInstallIncompleteError } from "./types";
import type { CloneTarget, RepoRef, ScmProvider } from "./types";

const GITHUB_API = "https://api.github.com";

function privateKey(): string {
  const key = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!key) throw new Error("GITHUB_APP_PRIVATE_KEY is not set");
  // .env files can't hold real newlines in a single-line value, so the key is stored with
  // literal "\n" escapes and unescaped here before signing.
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

function appId(): string {
  const id = process.env.GITHUB_APP_ID;
  if (!id) throw new Error("GITHUB_APP_ID is not set");
  return id;
}

// Authenticates as the app itself (not an installation) — used only to call the
// /app/installations/* endpoints below. Short-lived by GitHub's own requirement (max 10 min).
function signAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: appId() }, privateKey(), { algorithm: "RS256" });
}

// Minted fresh on every call, never cached or persisted — installation tokens are valid ~1hr
// and repo-scoped to whatever the installation covers, per ARCHITECTURE.md §5/§6.
async function getInstallationToken(installationId: number): Promise<string> {
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signAppJwt()}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API installation token mint failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  return body.token;
}

interface GithubInstallation {
  id: number;
  account: { login: string; type: string } | null;
}

function getInstallation(installationId: number): Promise<GithubInstallation> {
  return fetch(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: { Authorization: `Bearer ${signAppJwt()}`, Accept: "application/vnd.github+json" },
  }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`GitHub API /app/installations/${installationId} failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    return res.json() as Promise<GithubInstallation>;
  });
}

// Shared by findRepoAccess (names only, to check "does this installation see repoFullName")
// and listRepos (the full RepoRef shape, for the UI picker) — one HTTP call, two shapes.
async function listInstallationRepositories(installationId: number): Promise<{ id: number; full_name: string }[]> {
  const token = await getInstallationToken(installationId);
  const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API /installation/repositories failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { repositories: Array<{ id: number; full_name: string }> };
  return body.repositories;
}

const ISSUE_URL_RE = /github\.com\/([^/\s]+\/[^/\s.]+)\/issues\/(\d+)/;

function installationIdOf(connection: Connection): number {
  const id = connection.config.installationId;
  if (typeof id !== "number") throw new Error(`Connection ${connection.id} has no GitHub installationId`);
  return id;
}

function installationRefOf(target: CloneTarget): number {
  if (typeof target.installationRef !== "number") {
    throw new Error("CloneTarget.installationRef is not a GitHub installation id");
  }
  return target.installationRef;
}

export const githubScmProvider: ScmProvider = {
  id: "github",

  authorizeUrl(state) {
    const slug = process.env.GITHUB_APP_SLUG;
    if (!slug) throw new Error("GITHUB_APP_SLUG is not set");
    // GitHub's own install UI handles the repo picker; the caller only needs to route the
    // user there and verify `state` on the way back.
    return `https://github.com/apps/${slug}/installations/new?state=${state}`;
  },

  async completeInstall(params) {
    if (params.setupAction === "request") throw new ScmInstallIncompleteError("pending");
    if (!params.installationId) throw new ScmInstallIncompleteError("missing_installation");
    const installationId = Number(params.installationId);
    const installation = await getInstallation(installationId);
    return {
      label: installation.account?.login ?? `installation-${installationId}`,
      config: {
        installationId,
        accountLogin: installation.account?.login,
        accountType: installation.account?.type,
      },
    };
  },

  async listRepos(connection) {
    const installationId = connection.config.installationId;
    if (typeof installationId !== "number") return [];
    const repos = await listInstallationRepositories(installationId);
    return repos.map((r): RepoRef => ({ id: String(r.id), fullName: r.full_name }));
  },

  // Finds which of the org's GitHub connections has access to repoFullName — the same
  // org-scoping check backs both cloning/pushing and API reads like fetchIssue below, so a
  // repo outside every one of the org's installations is invisible to that org either way.
  async findRepoAccess(connections, repoFullName) {
    // Fail fast and loud on a misconfigured app — appId()/privateKey() already throw a clear
    // "X is not set" error. Checked here, before the loop below, so that error can't get
    // swallowed by the per-connection catch and misreported as "repo not accessible", which is
    // a completely different (and much more confusing) problem for whoever's debugging a
    // failed run.
    appId();
    privateKey();

    for (const connection of connections) {
      const installationId = connection.config.installationId;
      if (typeof installationId !== "number") continue;
      const repos = await listInstallationRepositories(installationId).catch(
        (): { id: number; full_name: string }[] => [],
      );
      if (repos.some((r) => r.full_name === repoFullName)) return connection;
    }
    return undefined;
  },

  // Mints a fresh installation token embedded directly in the clone URL. Nothing here is
  // persisted — the token is used once, for one clone, and expires on its own (~1hr) per
  // ARCHITECTURE.md §5/§6.
  async resolveCloneTarget(connection, repoFullName, branch) {
    const installationId = installationIdOf(connection);
    const token = await getInstallationToken(installationId);
    return {
      cloneUrl: `https://x-access-token:${token}@github.com/${repoFullName}.git`,
      remoteUrl: `https://github.com/${repoFullName}.git`,
      branch,
      repoFullName,
      provider: "github",
      installationRef: installationId,
    };
  },

  async mintPushToken(target) {
    const token = await getInstallationToken(installationRefOf(target));
    return token;
  },

  async fetchIssue(connection, repoFullName, issueNumber) {
    const token = await getInstallationToken(installationIdOf(connection));
    const res = await fetch(`${GITHUB_API}/repos/${repoFullName}/issues/${issueNumber}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`GitHub API issue fetch failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const issue = (await res.json()) as { title: string; body: string | null };
    return { title: issue.title, body: issue.body ?? "" };
  },

  async resolveDefaultBranchSha(connection, repoFullName) {
    const token = await getInstallationToken(installationIdOf(connection));
    const repoRes = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!repoRes.ok) {
      throw new Error(`GitHub API repo lookup failed: ${repoRes.status} ${await repoRes.text().catch(() => "")}`);
    }
    const { default_branch: branch } = (await repoRes.json()) as { default_branch: string };

    const commitRes = await fetch(`${GITHUB_API}/repos/${repoFullName}/commits/${branch}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!commitRes.ok) {
      throw new Error(`GitHub API commit lookup failed: ${commitRes.status} ${await commitRes.text().catch(() => "")}`);
    }
    const { sha } = (await commitRes.json()) as { sha: string };
    return sha;
  },

  // The eval judge's artefact when a run committed: the diff of exactly the commits that run
  // pushed, straight from the GitHub compare API in raw diff form. Both ends are commit shas,
  // never the branch name (which may have moved on since), so no ref-encoding question arises.
  async fetchCommitRangeDiff(target, range) {
    const token = await getInstallationToken(installationRefOf(target));
    const compareRes = await fetch(
      `${GITHUB_API}/repos/${target.repoFullName}/compare/${range.baseSha}...${range.headSha}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3.diff" } },
    );
    if (!compareRes.ok) {
      throw new Error(`GitHub API compare failed: ${compareRes.status} ${await compareRes.text().catch(() => "")}`);
    }
    return compareRes.text();
  },

  // Opens a draft PR against the repo's actual default branch (fetched fresh rather than
  // assumed "main"). draft:true and the app's own permissions (contents:write,
  // pull_requests:write, no admin) mean this token physically cannot merge or touch a
  // protected branch even if something upstream were wrong.
  async openDraftPullRequest(connection, repoFullName, branch, title, body) {
    const token = await getInstallationToken(installationIdOf(connection));
    const repoRes = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!repoRes.ok) {
      throw new Error(`GitHub API repo lookup failed: ${repoRes.status} ${await repoRes.text().catch(() => "")}`);
    }
    const { default_branch: base } = (await repoRes.json()) as { default_branch: string };

    const prRes = await fetch(`${GITHUB_API}/repos/${repoFullName}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, head: branch, base, body, draft: true }),
    });
    if (!prRes.ok) {
      throw new Error(`GitHub API PR creation failed: ${prRes.status} ${await prRes.text().catch(() => "")}`);
    }
    const pr = (await prRes.json()) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url };
  },

  // Task descriptions often are (or contain) a GitHub issue link — e.g. "https://github.com/
  // acme/widgets/issues/37" — pasted in as "what needs to be done".
  parseIssueReference(text) {
    const match = ISSUE_URL_RE.exec(text);
    if (!match) return undefined;
    return { repoFullName: match[1], issueNumber: Number(match[2]) };
  },
};
