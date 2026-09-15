# SCM provider abstraction — design spec

**Date:** 2026-09-15
**Status:** approved

## Problem

`apps/worker/src/scm-provider.ts` — the module that clones repos into sandboxes, pushes agent commits, opens draft PRs, and fetches issues/diffs during a run — talks to `api.github.com` directly, with no seam at all. Every exported function either calls the GitHub REST API by name or shells out a script with `github.com` hardcoded into it (`cloneIntoSandbox`'s remote-mismatch check at `apps/worker/src/scm-provider.ts:238`, and the plain-URL rewrite in both `cloneIntoSandbox:246` and `pushChangesIfDirty:349,358`). `findInstallationForRepo` (`apps/worker/src/scm-provider.ts:65-83`) filters an org's connections down to `c.provider === "github"` before doing anything else.

The same coupling exists a second time, independently, on the web side: `apps/web/src/server/github-app.ts` re-implements GitHub App JWT signing and installation-token minting to power the connection-setup flow (`/api/connections/github/{start,callback,repos}`). A comment at `apps/worker/src/scm-provider.ts:23-25` already flags this as duplication ("Duplicated from apps/web/src/server/github-app.ts rather than imported... Revisit if a third consumer needs it") — accepted at the time because there were only two call sites and ~20 lines between them. Generalizing to a second provider is that third consumer arriving.

This isn't a new direction — `ARCHITECTURE.md:409-411` already names the target: *"Port: `ScmProvider` (clone, branch, openPR, comment) so Bitbucket/GitLab slot in later"* — and `packages/core/src/domain.ts:137-147`'s `ConnectionProvider` union already lists `"bitbucket"` as a value nothing implements. The port was decided; it was never built.

## Goal

Move every GitHub-specific call behind a `ScmProvider` port with GitHub as its sole adapter, so a second provider can be added later — the way `ClaudeCodeRuntime` is the sole `AgentRuntime` adapter today (`ARCHITECTURE.md:47-94`) — without touching `apps/worker/src/worker.ts`, the task/agent API routes, or any component beyond the adapter itself and the small registry that selects it. No behavior change for GitHub in this pass.

## Ground truth this design relies on

- **`Connection.provider` is already a superset that includes unimplemented values.** `ConnectionProvider = "github" | "bitbucket" | "slack" | "telegram" | "discord" | "whatsapp" | "jira" | "monday" | "asana" | "google-sheets"` (`packages/core/src/domain.ts:137-147`). `Connection.kind` is `"scm" | "channel" | "tasks"` (`domain.ts:136`). Nothing currently filters `kind === "scm"` generically — code filters directly on `provider === "github"` instead (`scm-provider.ts:73`, `apps/web/src/app/api/connections/github/repos/route.ts`).
- **`task.codebase` is a plain string, `"owner/repo"`** (`packages/core/src/domain.ts:228`), passed straight into `resolveCloneTarget(orgId, task.codebase, branch)` (`worker.ts:144`). It carries no provider tag.
- **The monorepo already has five sibling packages** (`packages/core`, `packages/db`, `packages/queue`, `packages/shared`, `packages/storage`) alongside `apps/web` and `apps/worker`, wired via `pnpm-workspace.yaml`'s `packages: ["apps/*", "packages/*"]`. `packages/db` exports `listConnections`/`createConnection` (`packages/db/src/repositories/connections.ts`) and has no dependency on worker- or web-specific code — safe for a new package to depend on alongside `core`.
- **Every current GitHub call site, worker-side:** `getInstallationToken` (`scm-provider.ts:31-41`), `listInstallationRepoNames` (`:43-53`), `findInstallationForRepo` (`:65-83`), `resolveCloneTarget` (`:88-103`), `fetchIssue` (`:127-144`), `resolveDefaultBranchSha` (`:149-170`), `fetchCommitRangeDiff` (`:184-195`), `openDraftPullRequest` (`:434-465`), `parseIssueReference` (`:115-119`, a plain regex `github\.com/...\/issues\/(\d+)`, provider-specific by construction). `cloneIntoSandbox` (`:213-268`) and `pushChangesIfDirty` (`:299-396`) call the GitHub API only to mint a push token (`getInstallationToken`) — the rest is sandbox exec + shell script. `buildPullRequestBody`/`stripSandboxPaths` (`:402-422`) are pure text formatting with no API calls.
- **Every current GitHub call site, web-side:** `signAppJwt`, `getInstallationToken`, `listInstallationRepos`, `dedupeRepos`, `getInstallation` (`apps/web/src/server/github-app.ts`, all 95 lines), consumed by `/api/connections/github/start/route.ts` (redirect to GitHub's install UI), `/api/connections/github/callback/route.ts` (exchange `installation_id` → `createConnection({provider: "github", kind: "scm", ...})`), and `/api/connections/github/repos/route.ts` (list repos for the picker, filtering `c.provider === "github"`).
- **The repo picker is duplicated three times as a local `interface RepoOption { id: number; fullName: string }`**, each independently fetching `apiFetch<RepoOption[]>("/api/connections/github/repos")`: `apps/web/src/app/(app)/tasks/new/page.tsx:12,56`, `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx:11,53`, `apps/web/src/components/AgentFormModal.tsx:11,48`. Each renders a flat `<select>` of `repo.fullName` values (`tasks/new/page.tsx:252-263`, `AgentFormModal.tsx:118-129`, `tasks/[taskId]/edit/page.tsx:132-138`).
- **`ConnectionsList.tsx` already renders `conn.provider` generically** via `t(\`connections.provider.${conn.provider}\`)` (`ConnectionsList.tsx:37`) — only the "Connect" button is GitHub-specific, hardcoded to `/api/connections/github/start` (`ConnectionsList.tsx:74`).
- **No webhook receiver exists yet.** `ARCHITECTURE.md:418-419`'s planned `/webhooks/:provider` bus is unbuilt — confirmed by an empty search for webhook routes under `apps/web/src/app/api`. Out of scope by construction; nothing to migrate.
- **`packages/core`'s CLAUDE.md mandate** ("the single source of truth for all entity shapes... never duplicate these types elsewhere") governs where domain-shaped types go; provider-mechanics types (`CloneTarget`, `ScmIssue`, etc.) are not domain entities and belong in the new package instead.

## Scope

- **New package `packages/scm`** (`@agentfactory/scm`), depending on `@agentfactory/core` and `@agentfactory/db`:
  - `src/types.ts` — the `ScmProvider` interface and shared provider-mechanics types (`CloneTarget`, `ScmIssue`, `OpenedPullRequest`, `RepoRef`).
  - `src/github.ts` — `githubScmProvider: ScmProvider`, unifying every function currently duplicated between `scm-provider.ts` and `github-app.ts` (JWT signing, installation tokens, repo listing, issue fetch, PR open, default-branch/commit lookup, install-URL + callback exchange).
  - `src/registry.ts` — `getScmProvider(provider: ConnectionProvider): ScmProvider | undefined` and `resolveScmConnection(orgId, repoFullName): Promise<{ connection: Connection; provider: ScmProvider } | undefined>` (the generalized `findInstallationForRepo`: group the org's `kind: "scm"` connections by `provider`, try each registered provider's `findRepoAccess` in turn, first hit wins).
- **`apps/worker/src/scm-provider.ts` shrinks** to what's actually provider-agnostic: `cloneIntoSandbox`, `pushChangesIfDirty` (sandbox/shell mechanics, generalized to stop hardcoding `github.com` — see Design decisions), `buildPullRequestBody`, `stripSandboxPaths`. Every other export becomes a thin call into `resolveScmConnection` + the resolved provider's method.
- **`apps/web/src/server/github-app.ts` is deleted.** Its logic lives in `packages/scm/src/github.ts`; the three routes (`start`, `callback`, `repos`) call `getScmProvider("github")` (start/callback — provider fixed, since these are GitHub's own OAuth redirect targets) or the registry's cross-provider listing (repos — see below).
- **Repo picker generalization:**
  - `/api/connections/github/repos/route.ts` → `/api/connections/repos/route.ts`, aggregating `listRepos` across every one of the org's `scm` connections regardless of provider (not just GitHub).
  - The shared `RepoOption` shape gains `provider: ConnectionProvider`, deduplicated out of its three current copies into one exported type (natural side effect of touching all three call sites; not a separate goal).
  - The three consumers (`tasks/new`, `tasks/[taskId]/edit`, `AgentFormModal`) switch their fetch to the new endpoint and render `<optgroup>`-per-provider only when more than one distinct provider is present in the result — with a single provider connected (today: always), output is byte-identical to the current flat list.
- **Tests:** `apps/worker/src/__tests__/scm-provider.test.ts` and `apps/web/src/server/__tests__/github-app.test.ts` are rewritten against the new seams — see Testing.

## Out of scope

- **Implementing a second provider** (Bitbucket, GitLab). This design builds the port and proves it against exactly one adapter, matching how `AgentRuntime` shipped with only `ClaudeCodeRuntime` until M6 (`ARCHITECTURE.md:83-94`) — building a second adapter now, before anything demands one, would be guessing at a shape (Bitbucket has no "installation" concept; its OAuth flow, token model, and repo-listing pagination all differ) that only becomes clear when it's actually needed.
- **Generalizing `/api/connections/github/start` and `/callback` route paths.** These are GitHub's own redirect targets (`setup_url`, OAuth callback) — a second provider's install flow will need its own routes with its own shape regardless of what they're named. Renaming now to something like `/api/connections/[provider]/start` would be speculative; do it when a second adapter exists to prove the shape against.
- **Disambiguating `task.codebase` by provider** (e.g. `"github:owner/repo"`). Stays a plain string, resolved by trying each connected provider in turn (see Design decisions) — the same posture as the route-path point above.
- **The `/webhooks/:provider` inbound event bus** (`ARCHITECTURE.md:418-419`). Unbuilt; nothing to migrate.
- **`ChannelAdapter` and task-system MCP integrations** (`ARCHITECTURE.md:412-416`). Different port, different problem — not touched here.

## Design decisions

- **One `ScmProvider` interface covers both the web-side "connection setup" role and the worker-side "runtime" role**, rather than two separate ports. GitHub is the only adapter implementing it either way, and every method already shares the same underlying auth primitive (mint an installation token); splitting into two interfaces today would be a distinction with no second implementation to justify it. If a future provider's setup and runtime mechanics turn out to need genuinely different lifecycles, split then.
- **`cloneIntoSandbox` and `pushChangesIfDirty` stay as plain functions in `apps/worker/src/scm-provider.ts`, not adapter methods.** They never call the GitHub API themselves — they run shell scripts against a `CloneTarget` a provider already produced. The only GitHub-specific detail inside them is the hardcoded `github.com` in the plain (credential-stripped) remote URL. Fix: `CloneTarget` gains a `remoteUrl` field (the plain, credential-free URL: `https://github.com/owner/repo.git` today) alongside its existing `cloneUrl` (the credential-embedded one); the adapter supplies both, and the shell scripts interpolate `$REMOTE_URL` instead of hardcoding the host. `pushChangesIfDirty` also needs a *fresh* token at push time (the clone-time token may have aged past its ~1hr lifetime) — it already calls `getInstallationToken` itself for exactly this reason; that becomes a call to the resolved provider's own token-minting method instead, keeping the "always mint fresh, never persist" property scm-provider.ts:85-87's comment documents today.
- **`parseIssueReference` is tried across every registered provider, not dispatched to one.** Free-text task descriptions are parsed for an issue link *before* any repo or provider is known (`worker.ts:178`) — there's nothing to resolve a provider from yet. The registry exposes a `parseIssueReferenceAcrossProviders(text)` that loops the (currently one-element) provider list and returns the first match plus which provider it came from, replacing today's direct call to the GitHub-only regex.
- **Dispatch by trying each connected provider's `findRepoAccess`, not by tagging the repo string with a provider.** This mirrors the existing multi-installation loop (`findInstallationForRepo` already tries multiple GitHub installations per org) — extending it to try multiple *providers* the same way is consistent, and defers the real fix (provider-tagged `codebase`) to when a second provider's genuine collision risk exists to justify the schema change. Accepted risk: two providers with an identically-named repo would resolve to whichever is tried first (order: registration order in the registry) — a live wire only once a second provider is actually connected, not before.
- **The repo-listing endpoint generalizes now; the OAuth start/callback endpoints don't.** Listing is a pure aggregation ("show me everything reachable") with no provider-specific shape in its *response* — `RepoOption[]` is already provider-agnostic other than needing the one new field. Install/callback are inherently provider-shaped (GitHub's `installation_id` + `setup_action` query params have no Bitbucket equivalent) — generalizing their route surface has nothing real to generalize *against* yet.
- **Grouping the repo `<select>` by provider only when more than one provider is present.** With one provider connected (today, and for the lifetime of this design until a second adapter ships), the UI is pixel-identical to today's flat list — this is purely a latent capability, not a visible change yet.

## Mechanism

### Port (`packages/scm/src/types.ts`)

```ts
export interface CloneTarget {
  cloneUrl: string;   // credential-embedded, single-use
  remoteUrl: string;  // plain, credential-free — what the working tree's remote is set to after clone
  branch: string;
  repoFullName: string;
  installationRef: unknown; // opaque per-provider handle (GitHub: installationId)
}

export interface ScmIssue { title: string; body: string }
export interface OpenedPullRequest { number: number; url: string }
export interface RepoRef { id: string; fullName: string }

export interface ScmProvider {
  readonly id: ConnectionProvider;

  // Setup (apps/web)
  authorizeUrl(state: string): string;
  completeInstall(params: Record<string, string>): Promise<{ label: string; config: Record<string, unknown> }>;
  listRepos(connection: Connection): Promise<RepoRef[]>;

  // Runtime (apps/worker)
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

### Registry (`packages/scm/src/registry.ts`)

```ts
const providers: ScmProvider[] = [githubScmProvider]; // future: push a second adapter here

export function getScmProvider(id: ConnectionProvider): ScmProvider | undefined {
  return providers.find((p) => p.id === id);
}

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

### Worker call sites, before/after

```ts
// before (scm-provider.ts:144)
workspace = await resolveCloneTarget(agent.orgId, task.codebase, `agent/session-${session.id}`);

// after
const resolved = await resolveScmConnection(agent.orgId, task.codebase);
workspace = resolved && (await resolved.provider.resolveCloneTarget(resolved.connection, task.codebase, branch));
```

`cloneIntoSandbox`'s shell script (`scm-provider.ts:236-248`) changes only in its two `github.com`-hardcoded lines, now interpolating `$REMOTE_URL` (passed as an env var from `target.remoteUrl`) instead of `https://github.com/$REPO_FULL_NAME.git`. `pushChangesIfDirty` (`:349,358`) changes the same way, and replaces its own `getInstallationToken(target.installationId)` call (`:306`) with `provider.mintPushToken(target)`.

### Web routes, before/after

```ts
// before: /api/connections/github/callback/route.ts
const installation = await getInstallation(Number(installationId));
await createConnection(ctx.orgId, { provider: "github", kind: "scm", label: ..., config: {...} });

// after
const provider = getScmProvider("github")!;
const { label, config } = await provider.completeInstall({ installationId, setupAction, state, ...url.searchParams });
await createConnection(ctx.orgId, { provider: "github", kind: "scm", label, config });
```

```ts
// before: /api/connections/github/repos/route.ts — GitHub-only
// after: /api/connections/repos/route.ts
const scmConnections = (await listConnections(ctx.orgId)).filter((c) => c.kind === "scm");
const repoLists = await Promise.all(
  scmConnections.map(async (connection) => {
    const provider = getScmProvider(connection.provider);
    if (!provider) return [];
    try {
      return (await provider.listRepos(connection)).map((r) => ({ ...r, provider: connection.provider }));
    } catch {
      return [];
    }
  }),
);
return NextResponse.json(repoLists.flat());
```

### Repo picker grouping

```tsx
const providers = [...new Set(repos.map((r) => r.provider))];
{providers.length > 1
  ? providers.map((p) => (
      <optgroup key={p} label={t(`connections.provider.${p}`)}>
        {repos.filter((r) => r.provider === p).map((r) => (
          <option key={r.id} value={r.fullName}>{r.fullName}</option>
        ))}
      </optgroup>
    ))
  : repos.map((r) => <option key={r.id} value={r.fullName}>{r.fullName}</option>)}
```

Applied identically in `tasks/new/page.tsx`, `tasks/[taskId]/edit/page.tsx`, and `AgentFormModal.tsx`; the shared `RepoOption` type (`RepoRef & { provider: ConnectionProvider }`) is exported once from `packages/scm`'s `types.ts` and imported by all three, instead of redeclared locally in each file as today.

## Testing

- **`packages/scm/src/__tests__/github.test.ts`**: the GitHub adapter's own logic, migrated from today's `scm-provider.test.ts` and `github-app.test.ts` assertions — JWT signing, installation-token minting, `findRepoAccess` filtering, `resolveCloneTarget`'s URL shape, `completeInstall`'s state-mismatch/pending-install branches, `parseIssueReference`'s regex.
- **`apps/worker/src/__tests__/scm-provider.test.ts`** (rewritten, narrower): `cloneIntoSandbox` and `pushChangesIfDirty` against a stub `ScmProvider`/`CloneTarget` — asserting the shell script uses `target.remoteUrl` rather than a hardcoded host, and that a mismatched-repo checkout is still rejected. `buildPullRequestBody`/`stripSandboxPaths` tests carry over unchanged (pure functions, no seam change).
- **`packages/scm/src/__tests__/registry.test.ts`** (new): `resolveScmConnection` with two connections of *different* providers (one stubbed alongside GitHub) confirms it tries providers in order and returns the first match — the only way to exercise the multi-provider loop before a real second adapter exists.
- **`apps/web/src/app/api/connections/repos/__tests__/route.test.ts`** (new, replacing the deleted `github-app.test.ts` coverage of `dedupeRepos`): asserts repos from multiple `scm` connections (stubbed across two providers) are aggregated and tagged with the right `provider`.
- **Component test or manual check** for the `<optgroup>` grouping: single-provider case renders identically to today (regression guard), multi-provider case (stubbed `useMockBackend`/`apiFetch` response) renders one `<optgroup>` per provider.

## Risks

- **`CloneTarget.installationRef: unknown` is a real type-safety loosening** — today's `installationId: number` becomes an opaque per-provider handle. Contained: only the owning provider ever reads it back (`mintPushToken`, `fetchCommitRangeDiff` both take the whole `CloneTarget` and are implemented per-provider), so nothing outside `packages/scm/src/github.ts` needs to know its shape. Revisit if a second adapter's handle shape turns out to need something more structured than `unknown`.
- **`resolveScmConnection`'s "first matching provider wins" ordering is registration-order-dependent, not explicit.** Invisible today (one provider); becomes a real design question the moment a second one is registered. Flagged in Design decisions as an accepted, deferred cost rather than a silent gap.
- **Deleting `apps/web/src/server/github-app.ts` touches three live OAuth routes** (`start`, `callback`, `repos`) that a real GitHub App install flow depends on end-to-end. No behavior change is intended, but this is the one part of the migration that can't be fully verified by unit tests alone — worth a manual click-through of "connect GitHub → pick a repo → create a task" against a real (or sandboxed) GitHub App installation before merging, not just green CI.
