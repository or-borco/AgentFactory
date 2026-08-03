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
    return { cloneUrl: `https://x-access-token:${token}@github.com/${repoFullName}.git`, branch };
  }
  return undefined;
}

// Clones into /workspace on first use only — the same container is reused across a session's
// later runs (worker.ts's ensureSandbox), and re-cloning would wipe any uncommitted changes an
// earlier turn made. Exit status is read back via an echoed sentinel rather than a real exit
// code, matching the existing pattern in agent-runtime.ts (SandboxProvider.exec has no exit-code
// channel). The token lives only in an env var passed to the exec, never in argv.
export async function cloneIntoSandbox(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
): Promise<void> {
  const script =
    "test -d /workspace/.git && echo ALREADY_CLONED || " +
    '(git clone "$CLONE_URL" /workspace && cd /workspace && git checkout -b "$BRANCH_NAME" && echo CLONE_OK) || echo CLONE_FAILED';

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { CLONE_URL: target.cloneUrl, BRANCH_NAME: target.branch },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  const succeeded = stdout.includes("CLONE_OK") || stdout.includes("ALREADY_CLONED");
  if (!succeeded) {
    throw new Error("Failed to clone repository into sandbox workspace");
  }
}
