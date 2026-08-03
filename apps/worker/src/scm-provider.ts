import jwt from "jsonwebtoken";
import { listConnections } from "@agentfactory/db";
import type { SandboxProvider } from "./sandbox/types";

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

// Duplicated from apps/web/src/server/github-app.ts rather than imported — apps/worker and
// apps/web are separate processes/packages with no shared-code path between them today, and
// this is ~20 lines. Revisit if a third consumer needs it.
function signAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: appId() }, privateKey(), { algorithm: "RS256" });
}

async function getInstallationToken(installationId: number): Promise<string> {
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signAppJwt()}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API installation token mint failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function listInstallationRepoNames(installationId: number): Promise<string[]> {
  const token = await getInstallationToken(installationId);
  const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API /installation/repositories failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { repositories: Array<{ full_name: string }> };
  return body.repositories.map((r) => r.full_name);
}

export interface CloneTarget {
  cloneUrl: string;
  branch: string;
  repoFullName: string;
  installationId: number;
}

// Finds which of the org's GitHub connections has access to repoFullName, and mints a fresh
// installation token embedded directly in the clone URL. Nothing here is persisted — the token
// is used once, for one clone, and expires on its own (~1hr) per ARCHITECTURE.md §5/§6.
export async function resolveCloneTarget(
  orgId: number,
  repoFullName: string,
  branch: string,
): Promise<CloneTarget | undefined> {
  const githubConnections = (await listConnections(orgId)).filter((c) => c.provider === "github");

  for (const connection of githubConnections) {
    const installationId = connection.config.installationId;
    if (typeof installationId !== "number") continue;

    const repoNames = await listInstallationRepoNames(installationId).catch((): string[] => []);
    if (!repoNames.includes(repoFullName)) continue;

    const token = await getInstallationToken(installationId);
    return {
      cloneUrl: `https://x-access-token:${token}@github.com/${repoFullName}.git`,
      branch,
      repoFullName,
      installationId,
    };
  }
  return undefined;
}

// Clones into /workspace on first use only — the same container is reused across a session's
// later runs (worker.ts's ensureSandbox), and re-cloning would wipe any uncommitted changes an
// earlier turn made. When /workspace already has a repo, its remote is checked against the
// *current* target rather than assumed correct — a task's codebase can only be set once through
// today's UI, but nothing stops a direct API call (or a future edit UI) from changing it after
// the session already cloned a different repo, and silently continuing to work in the stale one
// would be a much worse failure mode than erroring clearly. Exit status is read back via an
// echoed sentinel rather than a real exit code, matching the existing pattern in
// agent-runtime.ts (SandboxProvider.exec has no exit-code channel). The token lives only in an
// env var passed to the exec, never in argv.
export async function cloneIntoSandbox(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
): Promise<void> {
  const script = `
if [ -d /workspace/.git ]; then
  CURRENT_REMOTE=$(cd /workspace && git remote get-url origin 2>/dev/null)
  case "$CURRENT_REMOTE" in
    *"github.com/$REPO_FULL_NAME.git") echo ALREADY_CLONED ;;
    *) echo REPO_MISMATCH ;;
  esac
else
  git clone "$CLONE_URL" /workspace && cd /workspace && git checkout -b "$BRANCH_NAME" && echo CLONE_OK || echo CLONE_FAILED
fi`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { CLONE_URL: target.cloneUrl, BRANCH_NAME: target.branch, REPO_FULL_NAME: target.repoFullName },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  if (stdout.includes("REPO_MISMATCH")) {
    throw new Error(
      `Sandbox workspace already contains a different repository than "${target.repoFullName}" — ` +
        "this session was likely started against a different task codebase and can't be reused for this one",
    );
  }
  const succeeded = stdout.includes("CLONE_OK") || stdout.includes("ALREADY_CLONED");
  if (!succeeded) {
    throw new Error("Failed to clone repository into sandbox workspace");
  }
}

// Commits and pushes only if the agent actually changed something — a read-only turn (e.g. "what
// does this file do?") leaves /workspace clean, and there's nothing to push or open a PR for.
// Returns whether anything was pushed. Reuses the origin remote already configured by
// cloneIntoSandbox (same embedded token, still within its ~1hr lifetime at this point in the
// run), so no fresh token is minted here.
export async function pushChangesIfDirty(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  branch: string,
  commitMessage: string,
  authorName: string,
): Promise<boolean> {
  const script = `
cd /workspace || { echo PUSH_FAILED; exit 0; }
if [ -z "$(git status --porcelain)" ]; then
  echo NO_CHANGES
else
  git add -A &&
  git -c user.email="agent@agentfactory.local" -c user.name="$AUTHOR_NAME" commit -m "$COMMIT_MESSAGE" &&
  git push -u origin "$BRANCH_NAME" &&
  echo PUSH_OK || echo PUSH_FAILED
fi`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { BRANCH_NAME: branch, COMMIT_MESSAGE: commitMessage, AUTHOR_NAME: authorName },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  if (stdout.includes("NO_CHANGES")) return false;
  if (stdout.includes("PUSH_OK")) return true;
  throw new Error("Failed to push agent changes to the remote");
}

export interface OpenedPullRequest {
  number: number;
  url: string;
}

// Opens a draft PR against the repo's actual default branch (fetched fresh rather than assumed
// "main" — plenty of repos default to something else). draft:true and a branch scoped to
// agent/session-* are the structural half of blast-radius containment: the app's own permissions
// (contents:write, pull_requests:write, no admin — see the GitHub App manifest) mean this token
// physically cannot merge or touch a protected branch even if something upstream were wrong.
export async function openDraftPullRequest(
  installationId: number,
  repoFullName: string,
  branch: string,
  title: string,
  body: string,
): Promise<OpenedPullRequest> {
  const token = await getInstallationToken(installationId);

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
}
