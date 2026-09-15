# SCM Provider Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every GitHub-specific call in `apps/worker/src/scm-provider.ts` and `apps/web/src/server/github-app.ts` behind a new `ScmProvider` port (in a new `packages/scm` workspace package) with GitHub as its sole adapter, so a second provider (Bitbucket, GitLab) can be added later without touching `apps/worker/src/worker.ts`, the task/agent API routes, or any component beyond the adapter itself and the small registry that selects it. No behavior change for GitHub in this pass.

**Architecture:** A new package `@agentfactory/scm` exports a `ScmProvider` interface, a `githubScmProvider: ScmProvider` adapter (unifying logic today duplicated between the worker and web GitHub clients), and a tiny registry (`getScmProvider`, `resolveScmConnection`, `parseIssueReferenceAcrossProviders`) that currently holds exactly one provider. `apps/worker/src/scm-provider.ts` shrinks to the sandbox/shell mechanics that never call a provider API directly (`cloneIntoSandbox`, `syncWithDefaultBranch`, `pushChangesIfDirty`, `buildPullRequestBody`) plus a set of same-named, same-signature thin wrapper exports (`resolveCloneTarget`, `fetchIssue`, `resolveDefaultBranchSha`, `fetchCommitRangeDiff`, `openDraftPullRequest`, `parseIssueReference`) that now delegate to the registry instead of calling `api.github.com` directly. `apps/web/src/server/github-app.ts` is deleted outright; its three route consumers call the registry instead.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Next.js 16 App Router Route Handlers, `jsonwebtoken` (GitHub App JWT signing, now living only in `packages/scm`).

## Global Constraints

- **No behavior change for GitHub in this pass** (design spec's Goal, `docs/superpowers/specs/2026-09-15-scm-provider-abstraction-design.md`).
- **New package `packages/scm` (`@agentfactory/scm`)** depends on `@agentfactory/core` and `@agentfactory/db` only (plus `jsonwebtoken`, added in Task 2 when it's actually needed).
- **`CloneTarget`** (in `packages/scm/src/types.ts`) has: `cloneUrl: string` (credential-embedded, single-use), `remoteUrl: string` (plain, credential-free — replaces every hardcoded `github.com` interpolation in the worker's shell scripts), `branch: string`, `repoFullName: string`, `provider: ConnectionProvider`, `installationRef: unknown` (opaque per-provider handle; GitHub: an installation id).
  - **Deviation from the design spec's literal type** (spec §Mechanism only lists `cloneUrl`/`remoteUrl`/`branch`/`repoFullName`/`installationRef`, no `provider` field): this plan adds `provider: ConnectionProvider` to `CloneTarget`. It's required, not optional — `pushChangesIfDirty` and `fetchCommitRangeDiff` are, per the spec's own Design decisions, kept as plain functions that only ever receive a `CloneTarget` (never an `orgId` or `Connection` alongside it), so without a tag on the target itself there is nothing to call `getScmProvider(...)` with.
- **`RepoRef.id` is `string`**, not `number` (spec §Mechanism). The old `InstallationRepo.private: boolean` field is dropped — confirmed unused by every consumer (`grep -rn "\.private\b"` across `apps/web/src` and `apps/worker/src` has zero hits outside `github-app.ts` itself).
- **Deviation from the design spec's literal `worker.ts` before/after snippet** (spec §Mechanism shows `worker.ts` calling `resolveScmConnection` directly): this plan instead follows the spec's §Scope contract literally — *"Every other export becomes a thin call into `resolveScmConnection` + the resolved provider's method"* — meaning `apps/worker/src/scm-provider.ts` **keeps exporting** `resolveCloneTarget`, `fetchIssue`, `resolveDefaultBranchSha`, `fetchCommitRangeDiff`, `parseIssueReference` with their **exact current signatures**, each now a thin wrapper. This is a smaller, safer diff, and it means `apps/worker/src/worker.ts`, `apps/worker/src/eval-artefact.ts`, and `apps/worker/src/repo-map.ts` — three consumers the spec's own §Ground truth section only partly enumerates — need **zero call-site changes**, except one: `worker.ts`'s `openDraftPullRequest(workspace.installationId, ...)` call becomes `openDraftPullRequest(agent.orgId, ...)`, because opening a PR now requires re-resolving a live `Connection` (to find the right provider), not just an opaque installation id. This is unavoidable under any reading of the design — `openDraftPullRequest`'s new port method takes a `Connection`, not a raw id.
- **`apps/worker/src/scm-provider.ts`'s credentialed push-URL construction inside `pushChangesIfDirty`** (`https://x-access-token:$PUSH_TOKEN@github.com/$REPO_FULL_NAME.git`) is left GitHub-shaped and unchanged. Only the plain, credential-free `$REMOTE_URL` interpolation (used by `cloneIntoSandbox` and `syncWithDefaultBranch`) is generalized — that's the literal scope of the spec's Design decision ("the only GitHub-specific detail... is the hardcoded github.com in the *plain* remote URL"). A second provider's credential-URL scheme is explicitly out of scope (spec §Out of scope: "Implementing a second provider").
- **`apps/web/src/app/api/connections/github/{start,callback}/route.ts` keep their current paths** (spec §Out of scope: "Generalizing... route paths"). Only `/api/connections/github/repos/route.ts` moves to `/api/connections/repos/route.ts` (spec §Scope).
- **Registry dispatch order = registration order** in the `providers` array; first matching provider wins (spec §Risks, accepted).
- Every task ends with `pnpm test:unit` passing. Run `pnpm typecheck` and `pnpm lint` clean before the final review.
- Read `docs/superpowers/specs/2026-09-15-scm-provider-abstraction-design.md` for full background — this plan implements it task-by-task, calling out every place this plan's concrete choices resolve an ambiguity the spec left open.

---

## Task 1: `packages/scm` package scaffold + port types

**Files:**
- Create: `packages/scm/package.json`
- Create: `packages/scm/tsconfig.json`
- Create: `packages/scm/src/types.ts`
- Create: `packages/scm/src/index.ts`

**Interfaces:**
- Produces: `CloneTarget`, `ScmIssue`, `OpenedPullRequest`, `RepoRef`, `RepoOption`, `ScmInstallIncompleteError`, `ScmProvider` — all exported from `@agentfactory/scm`. Every later task in this plan implements against these exact shapes.

- [ ] **Step 1: Create the package manifest**

Create `packages/scm/package.json`:

```json
{
  "name": "@agentfactory/scm",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@agentfactory/core": "workspace:*",
    "@agentfactory/db": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22",
    "typescript": "^5.9.3"
  }
}
```

This mirrors `packages/integrations/package.json`'s exact shape (the closest sibling package: a small package depending on `@agentfactory/core`, no build step, `tsc --noEmit` as its only script).

- [ ] **Step 2: Create the TS config**

Create `packages/scm/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

Identical to `packages/integrations/tsconfig.json` — this monorepo has no root `tsconfig.json` and no TS project references; every package's `tsconfig.json` is standalone.

- [ ] **Step 3: Write the port types**

Create `packages/scm/src/types.ts`:

```ts
import type { Connection, ConnectionProvider, RunCommitRange } from "@agentfactory/core";

// The clone/push handle a resolved repo produces. `cloneUrl` is credential-embedded and
// single-use (minted fresh per clone); `remoteUrl` is the plain, credential-free URL the
// working tree's `origin` is set to right after cloning — this is what lets
// apps/worker/src/scm-provider.ts's shell scripts stop hardcoding a host. `provider` lets a
// CloneTarget be routed back to the adapter that produced it later (pushChangesIfDirty and
// fetchCommitRangeDiff only ever receive a CloneTarget, never a Connection or orgId).
// `installationRef` is an opaque per-provider handle (GitHub: an installation id) — only the
// owning provider's own methods ever read it back.
export interface CloneTarget {
  cloneUrl: string;
  remoteUrl: string;
  branch: string;
  repoFullName: string;
  provider: ConnectionProvider;
  installationRef: unknown;
}

export interface ScmIssue {
  title: string;
  body: string;
}

export interface OpenedPullRequest {
  number: number;
  url: string;
}

export interface RepoRef {
  id: string;
  fullName: string;
}

// What the repo-picker UI actually renders — a RepoRef tagged with which connection it came
// from, so a picker with more than one connected provider can group its options.
export interface RepoOption extends RepoRef {
  provider: ConnectionProvider;
}

// Thrown by ScmProvider.completeInstall when the install flow reached the callback without
// actually finishing — either the org owner still needs to approve repo selection ("pending"),
// or the callback is missing the id it needs to look up what was installed
// ("missing_installation"). Callers map this to the same user-facing redirect the inline check
// produced before this abstraction existed.
export class ScmInstallIncompleteError extends Error {
  constructor(public readonly reason: "pending" | "missing_installation") {
    super(`SCM provider install incomplete: ${reason}`);
  }
}

export interface ScmProvider {
  readonly id: ConnectionProvider;

  // Setup (apps/web's connection-setup flow)
  authorizeUrl(state: string): string;
  completeInstall(params: Record<string, string>): Promise<{ label: string; config: Record<string, unknown> }>;
  listRepos(connection: Connection): Promise<RepoRef[]>;

  // Runtime (apps/worker's run pipeline)
  findRepoAccess(connections: Connection[], repoFullName: string): Promise<Connection | undefined>;
  resolveCloneTarget(connection: Connection, repoFullName: string, branch: string): Promise<CloneTarget>;
  mintPushToken(target: CloneTarget): Promise<string>;
  fetchIssue(connection: Connection, repoFullName: string, issueNumber: number): Promise<ScmIssue>;
  resolveDefaultBranchSha(connection: Connection, repoFullName: string): Promise<string>;
  fetchCommitRangeDiff(target: CloneTarget, range: RunCommitRange): Promise<string>;
  openDraftPullRequest(
    connection: Connection,
    repoFullName: string,
    branch: string,
    title: string,
    body: string,
  ): Promise<OpenedPullRequest>;
  parseIssueReference(text: string): { repoFullName: string; issueNumber: number } | undefined;
}
```

- [ ] **Step 4: Create the barrel export**

Create `packages/scm/src/index.ts`:

```ts
export * from "./types";
```

- [ ] **Step 5: Link the new workspace package and typecheck**

Run: `pnpm install` (from the repo root — this links `@agentfactory/scm` into the pnpm workspace; `pnpm-workspace.yaml` already globs `packages/*`, so no config change is needed there).

Run: `pnpm --filter @agentfactory/scm typecheck`
Expected: exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/scm pnpm-lock.yaml
git commit -m "feat(scm): scaffold @agentfactory/scm package with ScmProvider port types"
```

---

## Task 2: GitHub adapter (`packages/scm/src/github.ts`)

**Files:**
- Create: `packages/scm/src/github.ts`
- Create: `packages/scm/src/__tests__/github.test.ts`
- Modify: `packages/scm/package.json` (add `jsonwebtoken` + `@types/jsonwebtoken`)
- Modify: `packages/scm/src/index.ts`

**Interfaces:**
- Consumes: everything from Task 1 (`CloneTarget`, `ScmIssue`, `OpenedPullRequest`, `RepoRef`, `ScmProvider`, `ScmInstallIncompleteError`).
- Produces: `githubScmProvider: ScmProvider`, exported from `@agentfactory/scm`. Task 3 registers it in the registry; Task 4 and Task 5 call it (indirectly, through the registry) from the worker and web sides respectively.

This adapter unifies every GitHub call currently duplicated between `apps/worker/src/scm-provider.ts` (`signAppJwt`, `getInstallationToken`, `listInstallationRepoNames`, `findInstallationForRepo`, `resolveCloneTarget`, `fetchIssue`, `resolveDefaultBranchSha`, `fetchCommitRangeDiff`, `openDraftPullRequest`, `parseIssueReference`) and `apps/web/src/server/github-app.ts` (`signAppJwt`, `getInstallationToken`, `listInstallationRepos`, `dedupeRepos`, `findInstallationForRepo`, `resolveDefaultBranchSha`, `getInstallation`) — plus the install-flow logic (`authorizeUrl`, `completeInstall`) that today lives inline in `apps/web/src/app/api/connections/github/{start,callback}/route.ts`.

- [ ] **Step 1: Add the `jsonwebtoken` dependency**

Edit `packages/scm/package.json`'s `dependencies` and `devDependencies`:

```json
  "dependencies": {
    "@agentfactory/core": "workspace:*",
    "@agentfactory/db": "workspace:*",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^22",
    "typescript": "^5.9.3"
  }
```

Run: `pnpm install`

- [ ] **Step 2: Write the adapter**

Create `packages/scm/src/github.ts`:

```ts
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
async function getInstallationToken(installationId: number): Promise<{ token: string; expiresAt: string }> {
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signAppJwt()}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API installation token mint failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: body.expires_at };
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
  const { token } = await getInstallationToken(installationId);
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
    const { token } = await getInstallationToken(installationId);
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
    const { token } = await getInstallationToken(installationRefOf(target));
    return token;
  },

  async fetchIssue(connection, repoFullName, issueNumber) {
    const { token } = await getInstallationToken(installationIdOf(connection));
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
    const { token } = await getInstallationToken(installationIdOf(connection));
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
    const { token } = await getInstallationToken(installationRefOf(target));
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
    const { token } = await getInstallationToken(installationIdOf(connection));
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
```

- [ ] **Step 3: Export it from the barrel**

Edit `packages/scm/src/index.ts`:

```ts
export * from "./types";
export { githubScmProvider } from "./github";
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agentfactory/scm typecheck`
Expected: exits 0.

- [ ] **Step 5: Write the adapter's tests**

Create `packages/scm/src/__tests__/github.test.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @agentfactory/scm exec vitest run src/__tests__/github.test.ts` (or `pnpm test:unit` from the repo root, which picks it up via the shared `vitest.config.ts` glob)
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/scm
git commit -m "feat(scm): implement githubScmProvider, unifying worker/web GitHub clients"
```

---

## Task 3: Registry (`packages/scm/src/registry.ts`)

**Files:**
- Create: `packages/scm/src/registry.ts`
- Create: `packages/scm/src/__tests__/registry.test.ts`
- Modify: `packages/scm/src/index.ts`

**Interfaces:**
- Consumes: `githubScmProvider` (Task 2), `ScmProvider`/`Connection`/`ConnectionProvider` (Task 1).
- Produces: `getScmProvider(id): ScmProvider | undefined`, `resolveScmConnection(orgId, repoFullName): Promise<{connection, provider} | undefined>`, `parseIssueReferenceAcrossProviders(text): {repoFullName, issueNumber, provider} | undefined` — all exported from `@agentfactory/scm`. Task 4 and Task 5 call these.

- [ ] **Step 1: Write the registry**

Create `packages/scm/src/registry.ts`:

```ts
import { listConnections } from "@agentfactory/db";
import type { Connection, ConnectionProvider } from "@agentfactory/core";
import { githubScmProvider } from "./github";
import type { ScmProvider } from "./types";

// Exported (rather than a private module constant) so registry.test.ts can register a stub
// second provider to exercise multi-provider dispatch — production code never pushes to this
// beyond the fixed list below; there is exactly one real adapter until a second one ships.
export const providers: ScmProvider[] = [githubScmProvider]; // future: push a second adapter here

export function getScmProvider(id: ConnectionProvider): ScmProvider | undefined {
  return providers.find((p) => p.id === id);
}

// The generalized findInstallationForRepo: group the org's kind:"scm" connections by
// provider, try each registered provider's own findRepoAccess in turn, first hit wins.
export async function resolveScmConnection(
  orgId: number,
  repoFullName: string,
): Promise<{ connection: Connection; provider: ScmProvider } | undefined> {
  const scmConnections = (await listConnections(orgId)).filter((c) => c.kind === "scm");
  for (const provider of providers) {
    const own = scmConnections.filter((c) => c.provider === provider.id);
    const connection = await provider.findRepoAccess(own, repoFullName);
    if (connection) return { connection, provider };
  }
  return undefined;
}

// Free-text task descriptions are parsed for an issue link before any repo or provider is
// known — there's nothing to resolve a provider from yet, so every registered provider's own
// parser is tried in turn.
export function parseIssueReferenceAcrossProviders(
  text: string,
): { repoFullName: string; issueNumber: number; provider: ConnectionProvider } | undefined {
  for (const provider of providers) {
    const match = provider.parseIssueReference(text);
    if (match) return { ...match, provider: provider.id };
  }
  return undefined;
}
```

- [ ] **Step 2: Export it from the barrel**

Edit `packages/scm/src/index.ts`:

```ts
export * from "./types";
export { githubScmProvider } from "./github";
export { getScmProvider, resolveScmConnection, parseIssueReferenceAcrossProviders } from "./registry";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentfactory/scm typecheck`
Expected: exits 0.

- [ ] **Step 4: Write the registry's tests**

Create `packages/scm/src/__tests__/registry.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import type { ScmProvider } from "../types";

const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
vi.mock("@agentfactory/db", () => ({ listConnections: (orgId: number) => listConnectionsMock(orgId) }));

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
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit`
Expected: all tests pass, including the new `registry.test.ts` and `github.test.ts` from Task 2.

- [ ] **Step 6: Commit**

```bash
git add packages/scm
git commit -m "feat(scm): add provider registry (getScmProvider, resolveScmConnection, parseIssueReferenceAcrossProviders)"
```

---

## Task 4: Rewire `apps/worker`

**Files:**
- Modify: `apps/worker/src/scm-provider.ts` (full rewrite — shrinks to sandbox/shell mechanics + thin wrappers)
- Modify: `apps/worker/src/worker.ts` (one line: `openDraftPullRequest`'s first argument)
- Modify: `apps/worker/src/__tests__/scm-provider.test.ts` (full rewrite, narrower)
- Modify: `apps/worker/package.json` (add `@agentfactory/scm`; remove `jsonwebtoken` + `@types/jsonwebtoken`, no longer used here)

**Interfaces:**
- Consumes: `getScmProvider`, `resolveScmConnection`, `parseIssueReferenceAcrossProviders` (Task 3); `CloneTarget`, `OpenedPullRequest`, `ScmIssue` (Task 1).
- Produces: `apps/worker/src/scm-provider.ts` keeps exporting `resolveCloneTarget`, `fetchIssue`, `resolveDefaultBranchSha`, `fetchCommitRangeDiff`, `openDraftPullRequest`, `parseIssueReference`, `cloneIntoSandbox`, `syncWithDefaultBranch`, `pushChangesIfDirty`, `buildPullRequestBody`, plus the `CloneTarget`, `RepoSyncResult`, `PushResult` types — with the exact same signatures `apps/worker/src/eval-artefact.ts` and `apps/worker/src/repo-map.ts` already import (verified in this plan's research: both files import only `cloneIntoSandbox`, `resolveCloneTarget`, `fetchCommitRangeDiff`, `resolveDefaultBranchSha`, and the `CloneTarget` type — none of them need any edit).

- [ ] **Step 1: Add the `@agentfactory/scm` dependency, remove `jsonwebtoken`**

Edit `apps/worker/package.json`'s `dependencies` (remove `"jsonwebtoken": "^9.0.2"`, add `"@agentfactory/scm": "workspace:*"`) and `devDependencies` (remove `"@types/jsonwebtoken": "^9.0.7"`):

```json
  "dependencies": {
    "@agentfactory/core": "workspace:*",
    "@agentfactory/db": "workspace:*",
    "@agentfactory/integrations": "workspace:*",
    "@agentfactory/queue": "workspace:*",
    "@agentfactory/scm": "workspace:*",
    "@agentfactory/storage": "workspace:*",
    "@huggingface/transformers": "^3.7.0",
    "@anthropic-ai/claude-agent-sdk": "^0.3.220",
    "@anthropic-ai/sdk": "^0.115.0",
    "bullmq": "^5.81.2",
    "dockerode": "^5.0.1",
    "tar-stream": "^3.2.0"
  },
  "devDependencies": {
    "@types/dockerode": "^4.0.1",
    "@types/node": "^22",
    "@types/tar-stream": "^3.1.4",
    "dotenv": "17.4.2",
    "tsx": "^4.19.2",
    "typescript": "^5.9.3"
  }
```

Run: `pnpm install`

- [ ] **Step 2: Rewrite `apps/worker/src/scm-provider.ts`**

Replace the entire file with:

```ts
import type { RunCommitRange } from "@agentfactory/core";
import { getScmProvider, parseIssueReferenceAcrossProviders, resolveScmConnection } from "@agentfactory/scm";
import type { CloneTarget, OpenedPullRequest, ScmIssue } from "@agentfactory/scm";
import type { SandboxProvider } from "./sandbox/types";
import { TASK_DOCUMENT_EXCLUDE_PATTERN } from "./task-document-paths";
import { SKILL_EXCLUDE_PATTERN } from "./skill-paths";

export type { CloneTarget, OpenedPullRequest };
export type GitHubIssue = ScmIssue;

// Every path a sandbox checkout writes into that must never end up in the user's PR. Anything
// added here also needs .git/info/exclude taught about it in cloneIntoSandbox below.
const GIT_EXCLUDE_PATTERNS = [TASK_DOCUMENT_EXCLUDE_PATTERN, SKILL_EXCLUDE_PATTERN];

// Resolves which of the org's connected SCM providers/connections has access to repoFullName,
// then delegates to that provider's own clone-target resolution. Kept as a same-named,
// same-signature export — rather than inlining resolveScmConnection at each call site — so
// worker.ts, eval-artefact.ts, and repo-map.ts (all written against this exact signature)
// never had to change for this migration, and won't need to change again when a second
// provider ships either.
export async function resolveCloneTarget(
  orgId: number,
  repoFullName: string,
  branch: string,
): Promise<CloneTarget | undefined> {
  const resolved = await resolveScmConnection(orgId, repoFullName);
  if (!resolved) return undefined;
  return resolved.provider.resolveCloneTarget(resolved.connection, repoFullName, branch);
}

export function parseIssueReference(text: string): { repoFullName: string; issueNumber: number } | undefined {
  return parseIssueReferenceAcrossProviders(text);
}

// Fetches an issue's title/body via the same per-org connection lookup as resolveCloneTarget,
// so a task can only ever pull issue content from a repo the org's own connection can see.
export async function fetchIssue(
  orgId: number,
  repoFullName: string,
  issueNumber: number,
): Promise<GitHubIssue | undefined> {
  const resolved = await resolveScmConnection(orgId, repoFullName);
  if (!resolved) return undefined;
  return resolved.provider.fetchIssue(resolved.connection, repoFullName, issueNumber);
}

// Resolves a repo's default branch HEAD sha via the provider's API alone, with no sandbox and
// no clone — used by the repo-map pre-warm job to check whether a commit is already cached
// before paying for a container.
export async function resolveDefaultBranchSha(orgId: number, repoFullName: string): Promise<string | undefined> {
  const resolved = await resolveScmConnection(orgId, repoFullName);
  if (!resolved) return undefined;
  return resolved.provider.resolveDefaultBranchSha(resolved.connection, repoFullName);
}

// The eval judge's artefact when a run committed: the diff of exactly the commits that run
// pushed. `target` was already resolved (at clone time) against a specific provider — its own
// `provider` tag is what routes this call back to the right adapter, since there is no
// orgId/Connection available here to re-resolve one.
export async function fetchCommitRangeDiff(target: CloneTarget, range: RunCommitRange): Promise<string> {
  const provider = getScmProvider(target.provider);
  if (!provider) throw new Error(`No registered SCM provider for "${target.provider}"`);
  return provider.fetchCommitRangeDiff(target, range);
}

// Opens a draft PR. Unlike the other wrappers above, this one needs a live Connection (not
// just an opaque target) — re-resolves it from orgId + repoFullName, the same way
// resolveCloneTarget did at clone time.
export async function openDraftPullRequest(
  orgId: number,
  repoFullName: string,
  branch: string,
  title: string,
  body: string,
): Promise<OpenedPullRequest> {
  const resolved = await resolveScmConnection(orgId, repoFullName);
  if (!resolved) throw new Error(`No connected SCM provider can access repo "${repoFullName}"`);
  return resolved.provider.openDraftPullRequest(resolved.connection, repoFullName, branch, title, body);
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
// env var passed to the exec, never in argv — and once the clone succeeds, the remote is
// immediately rewritten to a plain, credential-free URL (target.remoteUrl — provider-agnostic,
// unlike the old hardcoded github.com). Leaving the token embedded in .git/config would sit
// there for the agent's entire turn, readable and directly usable by anything with Bash access
// (the agent has full unrestricted tool access — no canUseTool gate exists) to push anywhere or
// call the provider's API on its own initiative — a real gap this closes, not a hypothetical
// one. The set-url runs unconditionally (even if checkout fails) so a credential is never left
// behind on a partial failure.
export async function cloneIntoSandbox(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
): Promise<void> {
  const script = `
# Makes git blind to the directories task documents and pinned skills are materialised into (see
# task-documents.ts and skills-materialize.ts). Load-bearing, not hygiene: pushChangesIfDirty runs
# \`git add -A\` and decides whether there is anything to push from \`git status --porcelain\`, so
# without this an attached document or a materialised skill would be committed into the user's
# pull request, and merely attaching/pinning one would make a run that changed nothing look dirty.
# .git/info/exclude is per-clone and never committed — a .gitignore would itself show up in the
# diff.
#
# Idempotent (each pattern is checked independently before being appended) and applied on the
# already-cloned path too, so a sandbox created before either of these shipped picks up the
# missing pattern on its session's next run rather than pushing a stray directory once.
ensure_context_dir_excluded() {
  [ -d /workspace/.git ] || return 0
  mkdir -p /workspace/.git/info
  for pattern in ${GIT_EXCLUDE_PATTERNS.map((p) => `'${p}'`).join(" ")}; do
    grep -qxF "$pattern" /workspace/.git/info/exclude 2>/dev/null || printf '%s\\n' "$pattern" >> /workspace/.git/info/exclude
  done
}

if [ -d /workspace/.git ]; then
  CURRENT_REMOTE=$(cd /workspace && git remote get-url origin 2>/dev/null)
  case "$CURRENT_REMOTE" in
    "$REMOTE_URL") ensure_context_dir_excluded; echo ALREADY_CLONED ;;
    *) echo REPO_MISMATCH ;;
  esac
else
  git clone "$CLONE_URL" /workspace
  CLONE_STATUS=$?
  cd /workspace 2>/dev/null && git checkout -b "$BRANCH_NAME"
  CHECKOUT_STATUS=$?
  cd /workspace 2>/dev/null && git remote set-url origin "$REMOTE_URL"
  ensure_context_dir_excluded
  if [ "$CLONE_STATUS" -eq 0 ] && [ "$CHECKOUT_STATUS" -eq 0 ]; then echo CLONE_OK; else echo CLONE_FAILED; fi
fi`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { CLONE_URL: target.cloneUrl, REMOTE_URL: target.remoteUrl, BRANCH_NAME: target.branch },
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

export interface RepoSyncResult {
  status: "up_to_date" | "synced" | "skipped_dirty" | "skipped_conflict" | "skipped_fetch_failed";
  commitsMerged?: number;
  conflictingFiles?: string[];
}

// Runs on every run, right after cloneIntoSandbox — including the run that just did the actual
// first-time clone, where it's a correct, cheap no-op (HEAD already is origin/HEAD). A warm
// sandbox otherwise never re-fetches after its initial clone (see cloneIntoSandbox's
// ALREADY_CLONED path above), so a task's checkout can silently drift behind the default branch
// for as long as its session stays warm — this is what closes that gap, without requiring any
// task to declare a dependency on any other.
//
// Reuses target.cloneUrl's already-embedded token (minted moments earlier by resolveCloneTarget
// for this same run) rather than minting a new one, and strips it again immediately after the
// fetch — same inject-use-strip pattern pushChangesIfDirty uses below, for the same reason: never
// leave a usable credential sitting in the sandbox for the agent to find.
//
// Merges, never rebases: pushChangesIfDirty's own push is a plain, non-force `git push`, which
// only stays a fast-forward if the branch's existing tip remains an ancestor of the new HEAD. A
// merge preserves that; a rebase would rewrite history and break the next push.
//
// A dirty working tree (only expected if a prior run crashed before reaching its own push step)
// is left alone rather than stashed — git stash pop has no equivalent to `git merge --abort`'s
// clean restore, and this case self-heals on its own once the tree is clean on a later run.
export async function syncWithDefaultBranch(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
): Promise<RepoSyncResult> {
  const script = `
cd /workspace || { echo SYNC_SKIPPED_FETCH_FAILED; exit 0; }
git remote set-url origin "$CLONE_URL"
git fetch origin --quiet
FETCH_STATUS=$?
git remote set-url origin "$REMOTE_URL"
if [ "$FETCH_STATUS" -ne 0 ]; then echo SYNC_SKIPPED_FETCH_FAILED; exit 0; fi

if git merge-base --is-ancestor origin/HEAD HEAD 2>/dev/null; then
  echo SYNC_UP_TO_DATE
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo SYNC_SKIPPED_DIRTY
  exit 0
fi

BEFORE_SHA=$(git rev-parse HEAD)
if git merge --no-edit origin/HEAD >/dev/null 2>&1; then
  echo "SYNC_OK:$(git rev-list --count "$BEFORE_SHA..HEAD")"
else
  git diff --name-only --diff-filter=U | sed 's/^/SYNC_CONFLICT_FILE:/'
  git merge --abort
  echo SYNC_SKIPPED_CONFLICT
fi`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { CLONE_URL: target.cloneUrl, REMOTE_URL: target.remoteUrl },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  if (stdout.includes("SYNC_UP_TO_DATE")) return { status: "up_to_date" };
  if (stdout.includes("SYNC_SKIPPED_DIRTY")) return { status: "skipped_dirty" };
  const okMatch = /SYNC_OK:(\d+)/.exec(stdout);
  if (okMatch) return { status: "synced", commitsMerged: Number(okMatch[1]) };
  if (stdout.includes("SYNC_SKIPPED_CONFLICT")) {
    const conflictingFiles = stdout
      .split("\n")
      .filter((line) => line.startsWith("SYNC_CONFLICT_FILE:"))
      .map((line) => line.slice("SYNC_CONFLICT_FILE:".length).trim());
    return { status: "skipped_conflict", conflictingFiles };
  }
  // SYNC_SKIPPED_FETCH_FAILED, or any unrecognized output — fail soft, never throw. A sync is a
  // nice-to-have layered on top of a run that would otherwise proceed unchanged; a transient
  // network hiccup here should never be the reason a run fails.
  return { status: "skipped_fetch_failed" };
}

// Commits and pushes only if the agent actually changed something — a read-only turn (e.g. "what
// does this file do?") leaves /workspace clean, and there's nothing to push or open a PR for.
// Returns whether anything was pushed. This only ever runs *after* the agent's turn has already
// finished (called from worker.ts, not from anything the agent invokes), so it mints its own
// fresh token via the resolved provider's mintPushToken rather than relying on anything left
// over from cloneIntoSandbox — which no longer leaves a usable credential behind anyway (see
// that function's comment). The token is attached to the remote only for the duration of the
// push itself and stripped again immediately afterward, unconditionally (even on push failure),
// so a later turn in the same session never finds a working credential sitting in .git/config
// either.
//
// The credentialed push URL below stays GitHub-shaped (x-access-token:$TOKEN@github.com/...) —
// unlike cloneIntoSandbox/syncWithDefaultBranch's plain $REMOTE_URL, this one embeds a live
// credential, and a second provider's credential-URL scheme is explicitly out of scope for this
// migration (design spec §Out of scope: "Implementing a second provider").
export interface PushResult {
  pushed: boolean;
  // Paths committed in this turn, per `git diff-tree` on the new commit — not the whole repo
  // tree, so callers (the workspace-snapshot UI, the PR body) can show just what changed instead
  // of every file the clone happened to bring in.
  changedFiles: string[];
  // The commits this push added to target.branch, as a RunCommitRange. Absent when nothing was
  // pushed, and also when the sandbox could not name a base (a branch with no remote counterpart
  // and no origin/HEAD) — in which case the range is genuinely unknown and must not be guessed.
  commitRange?: RunCommitRange;
  // Set only when this run actually pushed commits. Set whenever the agent ended its turn
  // checked out on a branch other than target.branch (it has full unrestricted bash access —
  // nothing stops it running `git checkout -b`). When set, `agentBranch` is whatever branch it
  // was actually on. If that branch was a descendant of target.branch, the script fast-forwards
  // target.branch onto it before continuing (see the BRANCH_MISMATCH marker below) and `pushed`
  // reflects the recovered push; otherwise nothing is touched and `pushed` stays false — the
  // caller (worker.ts) surfaces either outcome as an event so it's never silently lost like it
  // was for T-047.
  branchMismatch?: { agentBranch: string };
}

export async function pushChangesIfDirty(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
  commitMessage: string,
  authorName: string,
): Promise<PushResult> {
  const provider = getScmProvider(target.provider);
  if (!provider) throw new Error(`No registered SCM provider for "${target.provider}"`);
  const token = await provider.mintPushToken(target);

  const script = `
cd /workspace || { echo PUSH_FAILED; exit 0; }

CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "$BRANCH_NAME" ]; then
  echo "BRANCH_MISMATCH:$CURRENT_BRANCH"
  # Only ever fast-forward — never rewrite history. If $BRANCH_NAME isn't an ancestor of what's
  # checked out now (agent ended up somewhere unrelated/behind), leave it alone and just check it
  # back out, so the next turn in this session still starts from the canonical branch.
  if git merge-base --is-ancestor "$BRANCH_NAME" HEAD 2>/dev/null; then
    git branch -f "$BRANCH_NAME" HEAD
  fi
  git checkout "$BRANCH_NAME"
fi

# "Anything to push" means uncommitted edits, or commits already made that the remote doesn't
# have yet (the agent may have committed its own work, on this branch or the one folded in
# above) — not just a dirty working tree, which is all the old check looked at. This first look
# uses whatever remote-tracking ref the sandbox already has cached, purely as a cheap no-op
# guard — it's refined below, once we know there's actually something to send, since a warm
# sandbox's cached ref for $BRANCH_NAME can be stale (see below).
STALE_BASE=$(git rev-parse --verify "origin/$BRANCH_NAME" 2>/dev/null || git rev-parse --verify origin/HEAD 2>/dev/null)
STALE_AHEAD=""
if [ -n "$STALE_BASE" ]; then
  STALE_AHEAD=$(git rev-list "$STALE_BASE..HEAD" 2>/dev/null)
fi

if [ -z "$(git status --porcelain)" ] && [ -z "$STALE_AHEAD" ]; then
  echo NO_CHANGES
else
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git -c user.email="agent@agentfactory.local" -c user.name="$AUTHOR_NAME" commit -m "$COMMIT_MESSAGE"
    COMMIT_STATUS=$?
  else
    COMMIT_STATUS=0
  fi
  git diff-tree --no-commit-id --name-only -r HEAD | sed 's/^/CHANGED_FILE:/'

  git remote set-url origin "https://x-access-token:$PUSH_TOKEN@github.com/$REPO_FULL_NAME.git"

  # Refresh our knowledge of $BRANCH_NAME's remote tip before pushing. Unlike the default branch
  # (kept warm by syncWithDefaultBranch on every run), nothing re-fetches $BRANCH_NAME itself once
  # the sandbox is cloned — so if an earlier run in this same warm session already pushed to it,
  # the cached origin/$BRANCH_NAME ref above is stale, and a plain push against a stale base is
  # exactly what git correctly rejects as non-fast-forward. Merge, never rebase, so the push below
  # stays a fast-forward instead of rewriting history the remote already has.
  git fetch origin "$BRANCH_NAME" --quiet
  if git rev-parse --verify "origin/$BRANCH_NAME" >/dev/null 2>&1 && ! git merge-base --is-ancestor "origin/$BRANCH_NAME" HEAD 2>/dev/null; then
    if git merge --no-edit "origin/$BRANCH_NAME" >/dev/null 2>&1; then
      echo MERGE_OK
    else
      git merge --abort
      echo MERGE_CONFLICT
    fi
  fi

  # Both ends of what this run is adding. BASE_SHA is the branch as the remote knew it before
  # this push (or the default branch, for the session's first run) — re-read fresh above rather
  # than reused from STALE_BASE, since that fetch may have moved it. HEAD_SHA is where it lands
  # after committing (and merging in any remote-only commits just fetched). Emitted here rather
  # than derived later because the branch keeps moving: once the next run pushes, nothing on the
  # branch can say which commits were this run's.
  UPSTREAM_BASE=$(git rev-parse --verify "origin/$BRANCH_NAME" 2>/dev/null || git rev-parse --verify origin/HEAD 2>/dev/null)
  if [ -n "$UPSTREAM_BASE" ]; then echo "BASE_SHA:$UPSTREAM_BASE"; fi
  echo "HEAD_SHA:$(git rev-parse HEAD)"
  # --no-verify: the repo's local pre-push hook (.husky/pre-push) assumes a developer's own
  # machine (it hardcodes a Homebrew PATH and shells out to pnpm) and the sandbox has neither
  # pnpm nor installed dependencies to run it — it always dies with "pnpm: not found" before the
  # push even reaches GitHub. This is the hook's own documented bypass, not a real test skip:
  # GitHub Actions (test.yml) still runs the full suite on the pushed branch, and a human reviews
  # the draft PR before merge either way.
  git push --no-verify -u origin "$BRANCH_NAME"
  PUSH_STATUS=$?
  git remote set-url origin "https://github.com/$REPO_FULL_NAME.git"
  if [ "$COMMIT_STATUS" -eq 0 ] && [ "$PUSH_STATUS" -eq 0 ]; then echo PUSH_OK; else echo PUSH_FAILED; fi
fi`;

  let stdout = "";
  let stderr = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: {
      BRANCH_NAME: target.branch,
      REPO_FULL_NAME: target.repoFullName,
      COMMIT_MESSAGE: commitMessage,
      AUTHOR_NAME: authorName,
      PUSH_TOKEN: token,
    },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
    else stderr += chunk.data;
  }

  const mismatchMatch = /^BRANCH_MISMATCH:(.*)$/m.exec(stdout);
  const branchMismatch = mismatchMatch ? { agentBranch: mismatchMatch[1] } : undefined;

  if (stdout.includes("NO_CHANGES")) return { pushed: false, changedFiles: [], branchMismatch };
  if (stdout.includes("PUSH_OK")) {
    const changedFiles = stdout
      .split("\n")
      .filter((line) => line.startsWith("CHANGED_FILE:"))
      .map((line) => line.slice("CHANGED_FILE:".length).trim())
      .filter(Boolean);
    const baseSha = /^BASE_SHA:(\S+)$/m.exec(stdout)?.[1];
    const headSha = /^HEAD_SHA:(\S+)$/m.exec(stdout)?.[1];
    // Both ends or neither: half a range cannot be compared, and a partial one would invite a
    // caller to fill in the other side from the branch tip — exactly the per-session guess this
    // field exists to replace.
    const commitRange = baseSha && headSha ? { baseSha, headSha } : undefined;
    return { pushed: true, changedFiles, branchMismatch, commitRange };
  }
  throw new Error(`Failed to push agent changes to the remote: ${stderr.trim() || stdout.trim()}`);
}

// The agent's summary is written from inside the sandbox, where the repo is checked out at
// /workspace — a container-internal mount point that means nothing on GitHub (and isn't even
// accurate there: the file is at the repo root, not under a "/workspace" directory). Strip it
// out before anything the agent wrote reaches a PR body meant for human reviewers.
function stripSandboxPaths(text: string): string {
  return text.replace(/\/workspace\//g, "").replace(/\/workspace\b/g, "the repo root");
}

// Composes an informative PR body from what the run actually produced, rather than the one-line
// "opened automatically for task T-xxx" placeholder — reviewers need the task's own description
// and the agent's own account of what it did to judge a draft PR without reading every diff line.
export function buildPullRequestBody(params: {
  taskRef: string;
  taskDescription: string;
  summary: string;
  changedFiles: string[];
}): string {
  const sections = [`Opened automatically by AgentFactory for task ${params.taskRef}.`];
  if (params.summary.trim()) sections.push(`## What changed\n${stripSandboxPaths(params.summary.trim())}`);
  if (params.taskDescription.trim()) sections.push(`## Task\n${params.taskDescription.trim()}`);
  if (params.changedFiles.length > 0) {
    sections.push(`## Files changed\n${params.changedFiles.map((f) => `- \`${f}\``).join("\n")}`);
  }
  return sections.join("\n\n");
}
```

- [ ] **Step 3: Update the one `worker.ts` call site**

In `apps/worker/src/worker.ts`, change the `openDraftPullRequest` call (around line 408):

```ts
// before
const pr = await openDraftPullRequest(
  workspace.installationId,
  workspace.repoFullName,
  workspace.branch,
  task.title,
  buildPullRequestBody({...}),
);

// after
const pr = await openDraftPullRequest(
  agent.orgId,
  workspace.repoFullName,
  workspace.branch,
  task.title,
  buildPullRequestBody({...}),
);
```

Only the first argument changes (`workspace.installationId` → `agent.orgId`) — `agent` is already in scope at this point in `worker.ts` (it's used two lines below, in `buildPullRequestBody`'s enclosing block, and throughout the function).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: exits 0. (If `workspace.installationId` is referenced anywhere else the earlier grep missed, this surfaces it as a compile error — `CloneTarget` no longer has that field.)

- [ ] **Step 5: Rewrite `apps/worker/src/__tests__/scm-provider.test.ts`**

Replace the entire file with:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";
import { SKILL_EXCLUDE_PATTERN } from "../skill-paths";

const resolveScmConnectionMock = vi.fn();
const getScmProviderMock = vi.fn();
const parseIssueReferenceAcrossProvidersMock = vi.fn();
vi.mock("@agentfactory/scm", () => ({
  resolveScmConnection: (orgId: number, repoFullName: string) => resolveScmConnectionMock(orgId, repoFullName),
  getScmProvider: (id: string) => getScmProviderMock(id),
  parseIssueReferenceAcrossProviders: (text: string) => parseIssueReferenceAcrossProvidersMock(text),
}));

const {
  buildPullRequestBody,
  cloneIntoSandbox,
  fetchCommitRangeDiff,
  fetchIssue,
  openDraftPullRequest,
  parseIssueReference,
  pushChangesIfDirty,
  resolveCloneTarget,
  resolveDefaultBranchSha,
  syncWithDefaultBranch,
} = await import("../scm-provider");

function fakeConnection(id: number): Connection {
  return {
    id,
    orgId: 1,
    provider: "github",
    kind: "scm",
    label: "installation-1",
    health: "healthy",
    config: {},
    auth: "none",
    createdAt: new Date().toISOString(),
  };
}

function fakeSandbox(chunks: OutputChunk[]): SandboxProvider {
  return {
    create: vi.fn(),
    exec: async function* () {
      for (const chunk of chunks) yield chunk;
    },
    writeFiles: vi.fn(),
    readWorkspace: vi.fn(),
    destroy: vi.fn(),
    exists: vi.fn(),
    resetMemory: vi.fn(),
  };
}

// Same as fakeSandbox, but keeps the argv it was called with so a test can assert on the
// shell script the caller actually built.
function capturingSandbox(chunks: OutputChunk[]): { sandbox: SandboxProvider; script: () => string } {
  let captured = "";
  return {
    sandbox: {
      create: vi.fn(),
      exec: async function* (_id: string, argv: string[]) {
        captured = argv[argv.length - 1];
        for (const chunk of chunks) yield chunk;
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    } as unknown as SandboxProvider,
    script: () => captured,
  };
}

afterEach(() => {
  resolveScmConnectionMock.mockReset();
  getScmProviderMock.mockReset();
  parseIssueReferenceAcrossProvidersMock.mockReset();
});

describe("resolveCloneTarget (thin wrapper over the registry)", () => {
  it("delegates to the resolved provider's resolveCloneTarget", async () => {
    const connection = fakeConnection(1);
    const providerResolveCloneTarget = vi.fn().mockResolvedValue({ repoFullName: "acme/widgets" });
    resolveScmConnectionMock.mockResolvedValue({ connection, provider: { resolveCloneTarget: providerResolveCloneTarget } });

    const result = await resolveCloneTarget(1, "acme/widgets", "agent/session-1");

    expect(resolveScmConnectionMock).toHaveBeenCalledWith(1, "acme/widgets");
    expect(providerResolveCloneTarget).toHaveBeenCalledWith(connection, "acme/widgets", "agent/session-1");
    expect(result).toEqual({ repoFullName: "acme/widgets" });
  });

  it("returns undefined when no connection resolves", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    await expect(resolveCloneTarget(1, "acme/widgets", "b")).resolves.toBeUndefined();
  });
});

describe("fetchIssue (thin wrapper over the registry)", () => {
  it("delegates to the resolved provider's fetchIssue", async () => {
    const connection = fakeConnection(1);
    const providerFetchIssue = vi.fn().mockResolvedValue({ title: "T", body: "B" });
    resolveScmConnectionMock.mockResolvedValue({ connection, provider: { fetchIssue: providerFetchIssue } });

    await expect(fetchIssue(1, "acme/widgets", 37)).resolves.toEqual({ title: "T", body: "B" });
    expect(providerFetchIssue).toHaveBeenCalledWith(connection, "acme/widgets", 37);
  });

  it("returns undefined when no connection resolves", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    await expect(fetchIssue(1, "acme/widgets", 37)).resolves.toBeUndefined();
  });
});

describe("resolveDefaultBranchSha (thin wrapper over the registry)", () => {
  it("delegates to the resolved provider's resolveDefaultBranchSha", async () => {
    const connection = fakeConnection(1);
    const providerFn = vi.fn().mockResolvedValue("abc123");
    resolveScmConnectionMock.mockResolvedValue({ connection, provider: { resolveDefaultBranchSha: providerFn } });

    await expect(resolveDefaultBranchSha(1, "acme/widgets")).resolves.toBe("abc123");
    expect(providerFn).toHaveBeenCalledWith(connection, "acme/widgets");
  });

  it("returns undefined when no connection resolves", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    await expect(resolveDefaultBranchSha(1, "acme/widgets")).resolves.toBeUndefined();
  });
});

describe("fetchCommitRangeDiff (thin wrapper over the registry)", () => {
  const target = { cloneUrl: "x", remoteUrl: "y", branch: "b", repoFullName: "acme/widgets", provider: "github" as const, installationRef: 1 };
  const range = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };

  it("delegates to the target's own provider", async () => {
    const providerFn = vi.fn().mockResolvedValue("diff text");
    getScmProviderMock.mockReturnValue({ fetchCommitRangeDiff: providerFn });

    await expect(fetchCommitRangeDiff(target, range)).resolves.toBe("diff text");
    expect(getScmProviderMock).toHaveBeenCalledWith("github");
    expect(providerFn).toHaveBeenCalledWith(target, range);
  });

  it("throws when the target's provider isn't registered", async () => {
    getScmProviderMock.mockReturnValue(undefined);
    await expect(fetchCommitRangeDiff(target, range)).rejects.toThrow('No registered SCM provider for "github"');
  });
});

describe("openDraftPullRequest (thin wrapper over the registry)", () => {
  it("delegates to the resolved provider's openDraftPullRequest", async () => {
    const connection = fakeConnection(1);
    const providerFn = vi.fn().mockResolvedValue({ number: 7, url: "https://example.com/pull/7" });
    resolveScmConnectionMock.mockResolvedValue({ connection, provider: { openDraftPullRequest: providerFn } });

    const pr = await openDraftPullRequest(1, "acme/widgets", "agent/session-1", "title", "body");

    expect(pr).toEqual({ number: 7, url: "https://example.com/pull/7" });
    expect(providerFn).toHaveBeenCalledWith(connection, "acme/widgets", "agent/session-1", "title", "body");
  });

  it("throws when no connection resolves", async () => {
    resolveScmConnectionMock.mockResolvedValue(undefined);
    await expect(openDraftPullRequest(1, "acme/widgets", "b", "t", "body")).rejects.toThrow(
      'No connected SCM provider can access repo "acme/widgets"',
    );
  });
});

describe("parseIssueReference (thin wrapper over the registry)", () => {
  it("delegates to parseIssueReferenceAcrossProviders", () => {
    parseIssueReferenceAcrossProvidersMock.mockReturnValue({ repoFullName: "a/b", issueNumber: 3, provider: "github" });
    expect(parseIssueReference("some text")).toEqual({ repoFullName: "a/b", issueNumber: 3, provider: "github" });
    expect(parseIssueReferenceAcrossProvidersMock).toHaveBeenCalledWith("some text");
  });
});

describe("cloneIntoSandbox", () => {
  const target = {
    cloneUrl: "https://x-access-token:ghs@github.com/acme-org/platform.git",
    remoteUrl: "https://github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
    provider: "github" as const,
    installationRef: 999,
  };

  it("resolves when the clone succeeds", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "CLONE_OK\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).resolves.toBeUndefined();
  });

  it("resolves without re-cloning when the workspace already has the same remote", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "ALREADY_CLONED\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).resolves.toBeUndefined();
  });

  it("throws a clear error when the workspace already has a different repo cloned", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "REPO_MISMATCH\n" }]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).rejects.toThrow(
      'Sandbox workspace already contains a different repository than "acme-org/platform"',
    );
  });

  it("compares the current remote against target.remoteUrl, not a hardcoded host", async () => {
    let captured: string[] = [];
    const exec = (_id: string, cmd: string[]) => {
      captured = cmd;
      return (async function* (): AsyncGenerator<OutputChunk> {
        yield { stream: "stdout", data: "CLONE_OK\n" };
      })();
    };
    const sandbox = { ...fakeSandbox([]), exec } as unknown as SandboxProvider;

    await cloneIntoSandbox(sandbox, "sandbox-1", target);

    const script = captured[2];
    expect(script).toContain('"$REMOTE_URL") ensure_context_dir_excluded; echo ALREADY_CLONED');
    expect(script).not.toContain("github.com/$REPO_FULL_NAME");
  });

  it("teaches git to ignore the task-document directory on a fresh clone", async () => {
    let captured: string[] = [];
    const exec = (_id: string, cmd: string[]) => {
      captured = cmd;
      return (async function* (): AsyncGenerator<OutputChunk> {
        yield { stream: "stdout", data: "CLONE_OK\n" };
      })();
    };
    const sandbox = { ...fakeSandbox([]), exec } as unknown as SandboxProvider;

    await cloneIntoSandbox(sandbox, "sandbox-1", target);

    const script = captured[2];
    expect(script).toContain(".git/info/exclude");
    expect(script).toContain("/.agentfactory/");
    expect(script).toContain("ensure_context_dir_excluded");
  });

  it("also teaches git to ignore the materialised-skills directory", async () => {
    let captured: string[] = [];
    const exec = (_id: string, cmd: string[]) => {
      captured = cmd;
      return (async function* (): AsyncGenerator<OutputChunk> {
        yield { stream: "stdout", data: "CLONE_OK\n" };
      })();
    };
    const sandbox = { ...fakeSandbox([]), exec } as unknown as SandboxProvider;

    await cloneIntoSandbox(sandbox, "sandbox-1", target);

    const script = captured[2];
    expect(script).toContain(SKILL_EXCLUDE_PATTERN);
  });

  it("throws when the clone fails", async () => {
    const sandbox = fakeSandbox([
      { stream: "stderr", data: "fatal: could not read Username\n" },
      { stream: "stdout", data: "CLONE_FAILED\n" },
    ]);
    await expect(cloneIntoSandbox(sandbox, "sandbox-1", target)).rejects.toThrow(
      "Failed to clone repository into sandbox workspace",
    );
  });

  it("passes the clone url, remote url, and branch as env vars, not argv", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: async function* (_id, _cmd, opts) {
        capturedEnv = opts?.env;
        yield { stream: "stdout", data: "CLONE_OK\n" };
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await cloneIntoSandbox(sandbox, "sandbox-1", target);

    expect(capturedEnv).toEqual({
      CLONE_URL: target.cloneUrl,
      REMOTE_URL: target.remoteUrl,
      BRANCH_NAME: target.branch,
    });
  });
});

describe("syncWithDefaultBranch", () => {
  const target = {
    cloneUrl: "https://x-access-token:ghs@github.com/acme-org/platform.git",
    remoteUrl: "https://github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
    provider: "github" as const,
    installationRef: 999,
  };

  it("reports up_to_date when nothing changed upstream", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "SYNC_UP_TO_DATE\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({ status: "up_to_date" });
  });

  it("reports synced with the number of commits merged", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "SYNC_OK:3\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({
      status: "synced",
      commitsMerged: 3,
    });
  });

  it("reports skipped_dirty without attempting a merge", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "SYNC_SKIPPED_DIRTY\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({ status: "skipped_dirty" });
  });

  it("reports skipped_conflict with the conflicting file paths", async () => {
    const sandbox = fakeSandbox([
      {
        stream: "stdout",
        data: "SYNC_CONFLICT_FILE:packages/db/src/schema.ts\nSYNC_CONFLICT_FILE:packages/core/src/domain.ts\nSYNC_SKIPPED_CONFLICT\n",
      },
    ]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({
      status: "skipped_conflict",
      conflictingFiles: ["packages/db/src/schema.ts", "packages/core/src/domain.ts"],
    });
  });

  it("fails soft to skipped_fetch_failed when the fetch itself fails", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "SYNC_SKIPPED_FETCH_FAILED\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({ status: "skipped_fetch_failed" });
  });

  it("fails soft to skipped_fetch_failed on unrecognized output, rather than throwing", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "\n" }]);
    await expect(syncWithDefaultBranch(sandbox, "sandbox-1", target)).resolves.toEqual({ status: "skipped_fetch_failed" });
  });

  it("passes the clone url and remote url as env vars, not a hardcoded host", async () => {
    let capturedEnv: Record<string, string> | undefined;
    let capturedScript = "";
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: async function* (_id, cmd, opts) {
        capturedEnv = opts?.env;
        capturedScript = cmd[cmd.length - 1];
        yield { stream: "stdout", data: "SYNC_UP_TO_DATE\n" };
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await syncWithDefaultBranch(sandbox, "sandbox-1", target);

    expect(capturedEnv).toEqual({ CLONE_URL: target.cloneUrl, REMOTE_URL: target.remoteUrl });
    expect(capturedScript).toContain('git remote set-url origin "$REMOTE_URL"');
    expect(capturedScript).not.toContain("github.com/$REPO_FULL_NAME");
  });
});

describe("pushChangesIfDirty", () => {
  const target = {
    cloneUrl: "https://x-access-token:ghs_clone@github.com/acme-org/platform.git",
    remoteUrl: "https://github.com/acme-org/platform.git",
    branch: "agent/session-1",
    repoFullName: "acme-org/platform",
    provider: "github" as const,
    installationRef: 999,
  };

  function mockProvider(token = "ghs_push") {
    const mintPushToken = vi.fn().mockResolvedValue(token);
    getScmProviderMock.mockReturnValue({ mintPushToken });
    return mintPushToken;
  }

  it("returns pushed:false and no changed files when the tree is clean", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "NO_CHANGES\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: false,
      changedFiles: [],
    });
  });

  it("returns pushed:true when the commit and push succeed", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toMatchObject({
      pushed: true,
    });
  });

  it("returns the paths committed in this turn, parsed out of the diff-tree marker lines", async () => {
    mockProvider();
    const sandbox = fakeSandbox([
      { stream: "stdout", data: "CHANGED_FILE:src/foo.ts\nCHANGED_FILE:README.md\n" },
      { stream: "stdout", data: "PUSH_OK\n" },
    ]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: true,
      changedFiles: ["src/foo.ts", "README.md"],
    });
  });

  it("reports the commit range this push added to the branch", async () => {
    mockProvider();
    const base = "1".repeat(40);
    const head = "2".repeat(40);
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `BASE_SHA:${base}\nHEAD_SHA:${head}\n` },
      { stream: "stdout", data: "PUSH_OK\n" },
    ]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toMatchObject({
      pushed: true,
      commitRange: { baseSha: base, headSha: head },
    });
  });

  it("re-fetches and merges the branch's remote tip before pushing, so a stale cached ref can't reject the push", async () => {
    mockProvider();
    const { sandbox, script } = capturingSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    const s = script();
    expect(s).toContain('git fetch origin "$BRANCH_NAME"');
    expect(s).toContain('git merge-base --is-ancestor "origin/$BRANCH_NAME" HEAD');
    expect(s).toContain('git merge --no-edit "origin/$BRANCH_NAME"');
    expect(s.indexOf('git fetch origin "$BRANCH_NAME"')).toBeLessThan(s.indexOf("git push --no-verify"));
  });

  it("aborts cleanly when merging in the remote tip conflicts", async () => {
    mockProvider();
    const { sandbox, script } = capturingSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    expect(script()).toContain("git merge --abort");
  });

  it("throws when the push fails", async () => {
    mockProvider();
    const sandbox = fakeSandbox([
      { stream: "stderr", data: "! [rejected]\n" },
      { stream: "stdout", data: "PUSH_FAILED\n" },
    ]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).rejects.toThrow(
      "Failed to push agent changes to the remote",
    );
  });

  it("throws when the target's provider isn't registered", async () => {
    getScmProviderMock.mockReturnValue(undefined);
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).rejects.toThrow(
      'No registered SCM provider for "github"',
    );
  });

  it("mints its push token via the resolved provider, keyed on the target's own provider id", async () => {
    const mintPushToken = mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "PUSH_OK\n" }]);

    await pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer");

    expect(getScmProviderMock).toHaveBeenCalledWith("github");
    expect(mintPushToken).toHaveBeenCalledWith(target);
  });

  it("reports a recovered branch mismatch when the agent committed on a descendant branch that got fast-forwarded", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "BRANCH_MISMATCH:fix/53-surface-real-run-error\nPUSH_OK\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: true,
      changedFiles: [],
      branchMismatch: { agentBranch: "fix/53-surface-real-run-error" },
    });
  });

  it("reports an unrecovered branch mismatch when the agent's branch wasn't a descendant of the session branch", async () => {
    mockProvider();
    const sandbox = fakeSandbox([{ stream: "stdout", data: "BRANCH_MISMATCH:main\nNO_CHANGES\n" }]);
    await expect(pushChangesIfDirty(sandbox, "sandbox-1", target, "msg", "Code reviewer")).resolves.toEqual({
      pushed: false,
      changedFiles: [],
      branchMismatch: { agentBranch: "main" },
    });
  });

  it("passes the token, repo, branch, commit message, and author as env vars, not argv — the token never appears in the command itself", async () => {
    mockProvider("ghs_push");
    let capturedEnv: Record<string, string> | undefined;
    let capturedCmd: string[] | undefined;
    const sandbox: SandboxProvider = {
      create: vi.fn(),
      exec: async function* (_id, cmd, opts) {
        capturedCmd = cmd;
        capturedEnv = opts?.env;
        yield { stream: "stdout", data: "PUSH_OK\n" };
      },
      writeFiles: vi.fn(),
      readWorkspace: vi.fn(),
      destroy: vi.fn(),
      exists: vi.fn(),
      resetMemory: vi.fn(),
    };

    await pushChangesIfDirty(sandbox, "sandbox-1", target, "Fix the bug", "Code reviewer");

    expect(capturedEnv).toEqual({
      BRANCH_NAME: "agent/session-1",
      REPO_FULL_NAME: "acme-org/platform",
      COMMIT_MESSAGE: "Fix the bug",
      AUTHOR_NAME: "Code reviewer",
      PUSH_TOKEN: "ghs_push",
    });
    expect(capturedCmd?.join(" ")).not.toContain("ghs_push");
  });
});

describe("buildPullRequestBody", () => {
  it("includes the task reference, the agent's summary, the task description, and the changed files", () => {
    const body = buildPullRequestBody({
      taskRef: "T-042",
      taskDescription: "Add a retry button to the failed-run banner.",
      summary: "Added a Retry button that re-enqueues the run.",
      changedFiles: ["src/RunBanner.tsx", "src/api.ts"],
    });

    expect(body).toContain("Opened automatically by AgentFactory for task T-042.");
    expect(body).toContain("Added a Retry button that re-enqueues the run.");
    expect(body).toContain("Add a retry button to the failed-run banner.");
    expect(body).toContain("- `src/RunBanner.tsx`");
    expect(body).toContain("- `src/api.ts`");
  });

  it("omits empty sections instead of leaving blank headings", () => {
    const body = buildPullRequestBody({ taskRef: "T-1", taskDescription: "", summary: "", changedFiles: [] });
    expect(body).toBe("Opened automatically by AgentFactory for task T-1.");
  });

  it("strips the sandbox's /workspace mount path out of the agent's summary", () => {
    const body = buildPullRequestBody({
      taskRef: "T-057",
      taskDescription: "",
      summary: "Created `/workspace/README.md` with a full local-setup guide. Files live under /workspace.",
      changedFiles: [],
    });

    expect(body).toContain("Created `README.md` with a full local-setup guide.");
    expect(body).toContain("Files live under the repo root.");
    expect(body).not.toContain("/workspace");
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test:unit`
Expected: all tests pass (this file's, and every other file's — nothing else in `apps/worker` should regress).

- [ ] **Step 7: Typecheck the whole worker**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/worker
git commit -m "refactor(worker): route scm-provider.ts through @agentfactory/scm's registry"
```

---

## Task 5: Rewire `apps/web`

**Files:**
- Delete: `apps/web/src/server/github-app.ts`
- Delete: `apps/web/src/server/__tests__/github-app.test.ts`
- Delete: `apps/web/src/app/api/connections/github/repos/route.ts`
- Create: `apps/web/src/app/api/connections/repos/route.ts`
- Create: `apps/web/src/app/api/connections/repos/__tests__/route.test.ts`
- Modify: `apps/web/src/app/api/connections/github/start/route.ts`
- Modify: `apps/web/src/app/api/connections/github/callback/route.ts`
- Modify: `apps/web/src/app/api/repos/map-status/route.ts`
- Modify: `apps/web/src/app/(app)/settings/page.tsx` (stale comment reference to a deleted file)
- Modify: `apps/web/package.json` (add `@agentfactory/scm`; remove `jsonwebtoken` + `@types/jsonwebtoken`)

**Interfaces:**
- Consumes: `getScmProvider`, `resolveScmConnection`, `ScmInstallIncompleteError`, `RepoOption` (all from `@agentfactory/scm`, Tasks 1–3).

- [ ] **Step 1: Add the `@agentfactory/scm` dependency, remove `jsonwebtoken`**

Edit `apps/web/package.json`:

```json
  "dependencies": {
    "@agentfactory/core": "workspace:*",
    "@agentfactory/db": "workspace:*",
    "@agentfactory/integrations": "workspace:*",
    "@agentfactory/queue": "workspace:*",
    "@agentfactory/scm": "workspace:*",
    "@agentfactory/shared": "workspace:*",
    "@agentfactory/storage": "workspace:*",
    "@phosphor-icons/react": "^2.1.10",
    "next": "16.2.12",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
```

(remove the `"jsonwebtoken": "^9.0.2"` line from `dependencies`, and remove `"@types/jsonwebtoken": "^9.0.7"` from `devDependencies`)

Run: `pnpm install`

- [ ] **Step 2: Delete the old GitHub App client module and its test**

```bash
git rm apps/web/src/server/github-app.ts apps/web/src/server/__tests__/github-app.test.ts
```

- [ ] **Step 3: Rewrite `apps/web/src/app/api/connections/github/start/route.ts`**

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { getScmProvider } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";

const STATE_COOKIE = "gh_connect_state";

export async function GET() {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return NextResponse.json({ error: "GITHUB_APP_SLUG is not set" }, { status: 500 });

  const state = randomBytes(16).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  // GitHub's own install UI handles the repo picker; we only need to route the user there
  // and verify `state` on the way back.
  const provider = getScmProvider("github")!;
  return NextResponse.redirect(provider.authorizeUrl(state));
}
```

(The `GITHUB_APP_SLUG` presence check stays here, ahead of the state cookie being set, matching today's exact ordering — `authorizeUrl` also checks it defensively, but this route's own check is what preserves today's error-before-any-side-effect behavior.)

- [ ] **Step 4: Rewrite `apps/web/src/app/api/connections/github/callback/route.ts`**

```ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createConnection } from "@agentfactory/db";
import { getScmProvider, ScmInstallIncompleteError } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";

const STATE_COOKIE = "gh_connect_state";

// This is the GitHub App manifest's `setup_url` — GitHub redirects here after a user
// installs (or updates) the app on their account/org.
export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");
  const state = url.searchParams.get("state");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (!state || state !== expectedState) {
    return NextResponse.redirect(new URL("/connections?error=state_mismatch", url));
  }

  const provider = getScmProvider("github")!;
  try {
    const { label, config } = await provider.completeInstall({
      installationId: installationId ?? "",
      setupAction: setupAction ?? "",
      state,
    });
    await createConnection(ctx.orgId, { provider: "github", kind: "scm", label, config });
  } catch (err) {
    if (err instanceof ScmInstallIncompleteError) {
      const error = err.reason === "pending" ? "install_pending" : "missing_installation";
      return NextResponse.redirect(new URL(`/connections?error=${error}`, url));
    }
    throw err;
  }

  return NextResponse.redirect(new URL("/connections?connected=github", url));
}
```

(The state-mismatch check stays inline here — it compares against an `httpOnly` cookie only this route can read, which has nothing to do with any specific SCM provider's mechanics. `setup_action=request` (pending) and a missing `installation_id` are GitHub-specific fields, and both now flow through `completeInstall`, which throws `ScmInstallIncompleteError` for either.)

- [ ] **Step 5: Delete the old repos route, create the aggregated one**

```bash
git rm apps/web/src/app/api/connections/github/repos/route.ts
```

Create `apps/web/src/app/api/connections/repos/route.ts`:

```ts
import { NextResponse } from "next/server";
import { listConnections } from "@agentfactory/db";
import { getScmProvider } from "@agentfactory/scm";
import type { RepoOption } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";

// Merges repo lists from every one of the org's scm connections, across every registered
// provider — dedupes by (provider, id) in case the same repo is reachable via more than one
// connection (e.g. two installations of the same GitHub App account).
function dedupeRepos(repos: RepoOption[]): RepoOption[] {
  const seen = new Set<string>();
  return repos.filter((repo) => {
    const key = `${repo.provider}:${repo.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const scmConnections = (await listConnections(ctx.orgId)).filter((c) => c.kind === "scm");

  const repoLists = await Promise.all(
    scmConnections.map(async (connection): Promise<RepoOption[]> => {
      const provider = getScmProvider(connection.provider);
      if (!provider) return [];
      try {
        const repos = await provider.listRepos(connection);
        return repos.map((r) => ({ ...r, provider: connection.provider }));
      } catch {
        // A revoked/broken installation shouldn't take down the whole picker — skip it.
        return [];
      }
    }),
  );

  return NextResponse.json(dedupeRepos(repoLists.flat()));
}
```

- [ ] **Step 6: Write the new route's tests**

Create `apps/web/src/app/api/connections/repos/__tests__/route.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@agentfactory/core";

vi.mock("@/server/auth", () => ({ requireAuthContext: vi.fn(async () => ({ orgId: 1 })) }));
const listConnectionsMock = vi.fn<(orgId: number) => Promise<Connection[]>>();
vi.mock("@agentfactory/db", () => ({ listConnections: (orgId: number) => listConnectionsMock(orgId) }));
const getScmProviderMock = vi.fn();
vi.mock("@agentfactory/scm", () => ({ getScmProvider: (id: string) => getScmProviderMock(id) }));

const { GET } = await import("../route");

function connection(id: number, provider: string): Connection {
  return {
    id,
    orgId: 1,
    provider: provider as never,
    kind: "scm",
    label: provider,
    health: "healthy",
    config: {},
    auth: "none",
    createdAt: new Date().toISOString(),
  };
}

afterEach(() => {
  listConnectionsMock.mockReset();
  getScmProviderMock.mockReset();
});

describe("GET /api/connections/repos", () => {
  it("aggregates repos from every scm connection and tags each with its provider", async () => {
    listConnectionsMock.mockResolvedValue([connection(1, "github"), connection(2, "bitbucket")]);
    getScmProviderMock.mockImplementation((id: string) => ({
      listRepos: async () =>
        id === "github" ? [{ id: "1", fullName: "acme/platform" }] : [{ id: "2", fullName: "acme/site" }],
    }));

    const res = await GET();
    await expect(res.json()).resolves.toEqual([
      { id: "1", fullName: "acme/platform", provider: "github" },
      { id: "2", fullName: "acme/site", provider: "bitbucket" },
    ]);
  });

  it("skips connections with no registered provider", async () => {
    listConnectionsMock.mockResolvedValue([connection(1, "asana")]);
    getScmProviderMock.mockReturnValue(undefined);

    const res = await GET();
    await expect(res.json()).resolves.toEqual([]);
  });

  it("skips a connection whose listRepos call throws, without failing the whole request", async () => {
    listConnectionsMock.mockResolvedValue([connection(1, "github"), connection(2, "github")]);
    getScmProviderMock.mockReturnValue({
      listRepos: vi
        .fn()
        .mockRejectedValueOnce(new Error("revoked"))
        .mockResolvedValueOnce([{ id: "1", fullName: "acme/platform" }]),
    });

    const res = await GET();
    await expect(res.json()).resolves.toEqual([{ id: "1", fullName: "acme/platform", provider: "github" }]);
  });

  it("dedupes repos that appear via more than one connection of the same provider", async () => {
    listConnectionsMock.mockResolvedValue([connection(1, "github"), connection(2, "github")]);
    getScmProviderMock.mockReturnValue({ listRepos: async () => [{ id: "1", fullName: "acme/platform" }] });

    const res = await GET();
    await expect(res.json()).resolves.toEqual([{ id: "1", fullName: "acme/platform", provider: "github" }]);
  });

  it("returns 401 when unauthenticated", async () => {
    const { requireAuthContext } = await import("@/server/auth");
    vi.mocked(requireAuthContext).mockResolvedValueOnce(undefined as never);

    const res = await GET();
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 7: Rewrite `apps/web/src/app/api/repos/map-status/route.ts`**

```ts
import { NextResponse } from "next/server";
import { getRepoMap } from "@agentfactory/db";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { resolveScmConnection } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";

// Answers "is this repo mapped for its current commit?" for the task-creation and task-edit
// forms' wait-choice banner (see docs/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md).
// checkable:false means "couldn't determine" (no connected SCM provider can see the repo, API
// error) — every caller treats that identically to "not mapped, but skip the prompt", never as
// an error to surface.
export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const repoFullName = new URL(request.url).searchParams.get("codebase");
  if (!repoFullName) return NextResponse.json({ error: "codebase is required" }, { status: 400 });

  const resolved = await resolveScmConnection(ctx.orgId, repoFullName).catch(() => undefined);
  const sha = resolved
    ? await resolved.provider.resolveDefaultBranchSha(resolved.connection, repoFullName).catch(() => undefined)
    : undefined;
  if (!sha) return NextResponse.json({ mapped: false, checkable: false });

  const cached = await getRepoMap(ctx.orgId, repoFullName, sha);
  return NextResponse.json({ mapped: Boolean(cached), checkable: true });
}

// Triggers the warm job ahead of the form actually submitting — see the design spec's "delay the
// submit itself" decision. Best-effort, matching every other warm-trigger call site: a queue
// outage must not block the caller, since a missed warm just means the poll on the other end of
// this feature (or, failing that, the run itself) pays the generation cost as it already does.
export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const repoFullName = body.codebase;
  if (!repoFullName) return NextResponse.json({ error: "codebase is required" }, { status: 400 });

  await enqueueRepoMapWarmJob(ctx.orgId, repoFullName).catch((err: unknown) => {
    console.error(`Failed to enqueue repo map warm job for ${repoFullName}:`, err);
  });
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Step 8: Fix the stale comment in `apps/web/src/app/(app)/settings/page.tsx`**

That file (around line 6–7) has a comment referencing the now-deleted `apps/web/src/server/github-app.ts`. Change it to reference the new location:

```ts
// before
// GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY are only ever read server-side (see
// apps/web/src/server/github-app.ts) — this page only exposes whether they're set, never their
// values, so it's safe to check them directly in a server component.

// after
// GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY are only ever read server-side (see
// packages/scm/src/github.ts) — this page only exposes whether they're set, never their
// values, so it's safe to check them directly in a server component.
```

- [ ] **Step 9: Run the tests**

Run: `pnpm test:unit`
Expected: all tests pass; the deleted `github-app.test.ts` is gone, and the new `apps/web/src/app/api/connections/repos/__tests__/route.test.ts` passes.

- [ ] **Step 10: Typecheck the whole web app**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: exits 0.

- [ ] **Step 11: Commit**

```bash
git add apps/web
git commit -m "refactor(web): delete github-app.ts, route connection setup through @agentfactory/scm"
```

---

## Task 6: Repo picker consolidation (3 UI consumers)

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/new/page.tsx`
- Modify: `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx`
- Modify: `apps/web/src/components/AgentFormModal.tsx`

**Interfaces:**
- Consumes: `RepoOption` from `@agentfactory/scm` (Task 1); the aggregated `/api/connections/repos` endpoint (Task 5).

Each of these three files declares its own local `interface RepoOption { id: number; fullName: string }` and fetches `/api/connections/github/repos`. This task replaces the local type with the shared `RepoOption` (now `{ id: string; fullName: string; provider: ConnectionProvider }`) from `@agentfactory/scm`, points the fetch at the new aggregated endpoint, and groups the `<select>` into `<optgroup>`s by provider — but **only when more than one provider is present**, so with a single connected provider (true today) the rendered output is byte-identical to before.

- [ ] **Step 1: `apps/web/src/app/(app)/tasks/new/page.tsx`**

Remove the local `interface RepoOption { id: number; fullName: string }` (lines 15–18) and add the import:

```ts
import type { RepoOption } from "@agentfactory/scm";
```

Change the fetch (around line 64):

```ts
// before
apiFetch<RepoOption[]>("/api/connections/github/repos")

// after
apiFetch<RepoOption[]>("/api/connections/repos")
```

Add a derived `repoProviders` constant next to the existing `defaultCodebase`/`preselectedCodebase` derivation (around line 112):

```ts
  const repoProviders = [...new Set(repos.map((repo) => repo.provider))];
  const defaultCodebase = selectedAgent?.defaultCodebase;
  const preselectedCodebase =
    defaultCodebase && repos.some((repo) => repo.fullName === defaultCodebase) ? defaultCodebase : "";
  const codebase = codebaseOverride ?? preselectedCodebase;
```

Replace the codebase `<select>`'s options (around lines 372–376):

```tsx
// before
              {repos.map((repo) => (
                <option key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}

// after
              {repoProviders.length > 1
                ? repoProviders.map((p) => (
                    <optgroup key={p} label={t(`connections.provider.${p}`)}>
                      {repos
                        .filter((repo) => repo.provider === p)
                        .map((repo) => (
                          <option key={repo.id} value={repo.fullName}>
                            {repo.fullName}
                          </option>
                        ))}
                    </optgroup>
                  ))
                : repos.map((repo) => (
                    <option key={repo.id} value={repo.fullName}>
                      {repo.fullName}
                    </option>
                  ))}
```

- [ ] **Step 2: `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx`**

Remove the local `interface RepoOption { id: number; fullName: string }` (lines 13–16) and add:

```ts
import type { RepoOption } from "@agentfactory/scm";
```

Change the fetch (around line 55):

```ts
apiFetch<RepoOption[]>("/api/connections/repos")
```

Add `const repoProviders = [...new Set(repos.map((repo) => repo.provider))];` right after the `[repos, setRepos]` state declaration (around line 32).

Replace the codebase `<select>`'s options (around lines 149–153):

```tsx
// before
              {repos.map((repo) => (
                <option key={repo.id} value={repo.fullName}>
                  {repo.fullName}
                </option>
              ))}

// after
              {repoProviders.length > 1
                ? repoProviders.map((p) => (
                    <optgroup key={p} label={t(`connections.provider.${p}`)}>
                      {repos
                        .filter((repo) => repo.provider === p)
                        .map((repo) => (
                          <option key={repo.id} value={repo.fullName}>
                            {repo.fullName}
                          </option>
                        ))}
                    </optgroup>
                  ))
                : repos.map((repo) => (
                    <option key={repo.id} value={repo.fullName}>
                      {repo.fullName}
                    </option>
                  ))}
```

- [ ] **Step 3: `apps/web/src/components/AgentFormModal.tsx`**

Remove the local `interface RepoOption { id: number; fullName: string }` (lines 11–14) and add:

```ts
import type { RepoOption } from "@agentfactory/scm";
```

Change the fetch (around line 48):

```ts
apiFetch<RepoOption[]>("/api/connections/repos")
```

Add `const repoProviders = [...new Set(repos.map((repo) => repo.provider))];` right after the `hasCurrentRepo` derivation (around line 62).

Replace the `<select>`'s options (around lines 126–131), keeping the existing "stale default codebase" fallback option untouched:

```tsx
// before
            {!hasCurrentRepo && <option value={defaultCodebase}>{defaultCodebase}</option>}
            {repos.map((repo) => (
              <option key={repo.id} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}

// after
            {!hasCurrentRepo && <option value={defaultCodebase}>{defaultCodebase}</option>}
            {repoProviders.length > 1
              ? repoProviders.map((p) => (
                  <optgroup key={p} label={t(`connections.provider.${p}`)}>
                    {repos
                      .filter((repo) => repo.provider === p)
                      .map((repo) => (
                        <option key={repo.id} value={repo.fullName}>
                          {repo.fullName}
                        </option>
                      ))}
                  </optgroup>
                ))
              : repos.map((repo) => (
                  <option key={repo.id} value={repo.fullName}>
                    {repo.fullName}
                  </option>
                ))}
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm --filter @agentfactory/web typecheck && pnpm --filter @agentfactory/web lint`
Expected: both exit 0.

- [ ] **Step 5: Run the full unit suite**

Run: `pnpm test:unit`
Expected: all tests pass.

- [ ] **Step 6: Manual browser verification (single-provider regression check)**

The design spec calls for either a component test or a manual check for the `<optgroup>` grouping (§Testing); given only one provider (GitHub) is ever connected today, and every one of these three components is a heavily-hooked Next.js page/modal that would need substantial mocking to unit-test in isolation, this plan uses the manual check. After this task's implementer finishes, the controller session (not this task's implementer) verifies in a real browser, using the running dev server:
1. Start the dev server, sign in, ensure at least one GitHub connection exists.
2. Visit `/tasks/new` — confirm the codebase `<select>` renders a flat list of repos (no `<optgroup>`), identical to before this task.
3. Open the "New agent" modal (or equivalent `AgentFormModal` entry point) and confirm the same for its default-codebase picker.
4. Visit `/tasks/[taskId]/edit` for an existing task and confirm the same.

This step has no automated pass/fail — it's a visual regression check the controller performs directly.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "refactor(web): consolidate RepoOption and group the repo picker by provider"
```

---

## Final Verification (whole branch)

After Task 6, before the final code review:

- [ ] Run `pnpm typecheck` (all packages) — expect 0 errors.
- [ ] Run `pnpm lint` (all packages) — expect 0 errors.
- [ ] Run `pnpm test:unit` — expect all tests passing, with no leftover references to `apps/web/src/server/github-app.ts` or `apps/web/src/app/api/connections/github/repos/route.ts` anywhere (`grep -rn "github-app\|connections/github/repos" apps/web/src apps/worker/src --include="*.ts" --include="*.tsx"` should return nothing outside the still-current `start`/`callback` routes and their manifest URLs).
- [ ] Perform Task 6 Step 6's manual browser check if it wasn't already done as part of that task.
