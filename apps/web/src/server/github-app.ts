import { listConnections } from "@agentfactory/db";
import jwt from "jsonwebtoken";

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
export function signAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: appId() }, privateKey(), { algorithm: "RS256" });
}

async function githubAppRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${signAppJwt()}`,
      Accept: "application/vnd.github+json",
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

export interface GithubInstallation {
  id: number;
  account: { login: string; type: string } | null;
}

export function getInstallation(installationId: number): Promise<GithubInstallation> {
  return githubAppRequest<GithubInstallation>(`/app/installations/${installationId}`);
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

// Minted fresh on every call, never cached or persisted — installation tokens are valid ~1hr
// and repo-scoped to whatever the installation covers, per ARCHITECTURE.md §5/§6.
export async function getInstallationToken(installationId: number): Promise<InstallationToken> {
  const result = await githubAppRequest<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
  );
  return { token: result.token, expiresAt: result.expires_at };
}

export interface InstallationRepo {
  id: number;
  fullName: string;
  private: boolean;
}

// Requires an installation token (not the app JWT githubAppRequest signs) — this endpoint
// answers "what can THIS installation see", which is meaningless for the app identity itself.
export async function listInstallationRepos(installationId: number): Promise<InstallationRepo[]> {
  const { token } = await getInstallationToken(installationId);
  const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API /installation/repositories failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as { repositories: Array<{ id: number; full_name: string; private: boolean }> };
  return body.repositories.map((r) => ({ id: r.id, fullName: r.full_name, private: r.private }));
}

// Merges repo lists from multiple installations (an org can connect more than one GitHub
// account/org), deduping by repo id in case the same repo ever appears twice.
export function dedupeRepos(lists: InstallationRepo[][]): InstallationRepo[] {
  const seen = new Set<number>();
  return lists.flat().filter((repo) => {
    if (seen.has(repo.id)) return false;
    seen.add(repo.id);
    return true;
  });
}

// Finds which of the org's GitHub connections has an installation that can see repoFullName.
// Mirrors apps/worker/src/scm-provider.ts's function of the same name — deliberately duplicated,
// not imported, matching this file's existing precedent (see signAppJwt above).
export async function findInstallationForRepo(orgId: number, repoFullName: string): Promise<number | undefined> {
  const githubConnections = (await listConnections(orgId)).filter((c) => c.provider === "github");
  for (const connection of githubConnections) {
    const installationId = connection.config.installationId;
    if (typeof installationId !== "number") continue;
    const repos = await listInstallationRepos(installationId).catch(() => []);
    if (repos.some((repo) => repo.fullName === repoFullName)) return installationId;
  }
  return undefined;
}

// Resolves a repo's default branch HEAD sha via the GitHub API alone, no sandbox and no clone —
// used by the map-status route to answer "is this repo mapped?" from apps/web directly. Mirrors
// apps/worker/src/scm-provider.ts's resolveDefaultBranchSha; failures return undefined here
// rather than throwing, since every caller in this feature treats "can't tell" the same as
// "not mapped, but skip the prompt" (see the map-status route).
export async function resolveDefaultBranchSha(orgId: number, repoFullName: string): Promise<string | undefined> {
  const installationId = await findInstallationForRepo(orgId, repoFullName);
  if (installationId === undefined) return undefined;

  const { token } = await getInstallationToken(installationId);
  const repoRes = await fetch(`${GITHUB_API}/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!repoRes.ok) return undefined;
  const { default_branch: branch } = (await repoRes.json()) as { default_branch: string };

  const commitRes = await fetch(`${GITHUB_API}/repos/${repoFullName}/commits/${branch}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!commitRes.ok) return undefined;
  const { sha } = (await commitRes.json()) as { sha: string };
  return sha;
}
