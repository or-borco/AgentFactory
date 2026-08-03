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
