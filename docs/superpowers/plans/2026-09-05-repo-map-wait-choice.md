# Repo map wait choice at task creation/edit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user sets a codebase with no cached repo map (on the "New Task" form or the task edit page), show an inline banner letting them choose to wait for the map before saving, or proceed immediately without one.

**Architecture:** A new `GET`/`POST /api/repos/map-status` route answers "is this repo mapped?" and "start mapping it," reusing the org's existing GitHub App installation the same way `/api/connections/github/repos` already does. A shared client-side hook (`useRepoMapWaitGate`) drives the check/poll/escape-hatch state machine, rendered by a shared presentational component (`RepoMapWaitBanner`), wired into both forms identically apart from which request each form's own submit eventually fires.

**Tech Stack:** Next.js 16 App Router Route Handlers, React (client components), Vitest + `@testing-library/react` for component/hook tests, Drizzle via `@agentfactory/db`, BullMQ via `@agentfactory/queue`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md` — every task below implements a specific section of it; read it once before starting.
- Do **not** touch `apps/worker/src/repo-map.ts`'s poll (`CACHE_POLL_TIMEOUT_MS`/`ensureRepoMap`) or anything in PR #156 — that removal is a separate, later change (spec's "What's left for PR #156's poll to cover").
- Every new server-side piece fails open: if the map-status check can't determine an answer, the caller must treat it as "don't show the banner," never as an error that blocks the form.
- No new `Task` domain fields, no DB schema changes, no new `TaskStatus`/`RunStatus` values — this feature lives entirely in `apps/web`, ahead of the existing `POST /api/tasks` / `PATCH /api/tasks/[taskId]` calls, which stay unchanged.
- Follow existing conventions exactly: `requireAuthContext()` for auth, `{ error: "Message" }` (capitalized) for error bodies, `apiFetch<T>()` for all client-side calls, `useTranslation()`/`t()` for all user-facing strings (add new keys to `apps/web/src/lib/i18n/dictionaries/en.ts` — the `TranslationKey` type updates automatically).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/server/github-app.ts` (modified) | Add `findInstallationForRepo` + `resolveDefaultBranchSha` — resolving a repo's current commit sha via the org's GitHub App installation. |
| `apps/web/src/app/api/repos/map-status/route.ts` (new) | `GET` — is `codebase` mapped for its current sha? `POST` — trigger the warm job for `codebase`. |
| `apps/web/src/lib/use-repo-map-wait-gate.ts` (new) | Client-side hook: owns the check/prompt/waiting/poll/escape-hatch state machine. No JSX. |
| `apps/web/src/components/RepoMapWaitBanner.tsx` (new) | Presentational component rendering the hook's state — the banner and the waiting screen from the approved mockups. |
| `apps/web/src/app/(app)/tasks/new/page.tsx` (modified) | Wire the hook + banner in; submit only fires once the gate is clear. |
| `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx` (modified) | Same wiring, `PATCH` instead of `POST`. |
| `apps/web/src/lib/i18n/dictionaries/en.ts` (modified) | New `tasks.repoMapWait.*` strings. |

---

### Task 1: `findInstallationForRepo` + `resolveDefaultBranchSha` in `github-app.ts`

**Files:**
- Modify: `apps/web/src/server/github-app.ts`
- Test: `apps/web/src/server/__tests__/github-app.test.ts`

**Interfaces:**
- Produces: `findInstallationForRepo(orgId: number, repoFullName: string): Promise<number | undefined>`, `resolveDefaultBranchSha(orgId: number, repoFullName: string): Promise<string | undefined>` — both exported from `apps/web/src/server/github-app.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/server/__tests__/github-app.test.ts` (after the existing `dedupeRepos` describe block):

```ts
import { listConnections } from "@agentfactory/db";

vi.mock("@agentfactory/db", () => ({ listConnections: vi.fn() }));

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
```

Also add `vi.mock("@agentfactory/db", ...)` and the `listConnections` import at the top of the file alongside the existing `vi.mock("jsonwebtoken", ...)` — the file-level mock must be declared once, so merge it with the existing mock block rather than duplicating `vi.mock`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentfactory/web test -- github-app -t "findInstallationForRepo"`
Expected: FAIL — `findInstallationForRepo` is not exported.

- [ ] **Step 3: Implement `findInstallationForRepo` and `resolveDefaultBranchSha`**

In `apps/web/src/server/github-app.ts`, add the import and the two functions (mirrors `apps/worker/src/scm-provider.ts`'s module-private version, deliberately duplicated per that file's own precedent for `signAppJwt`):

```ts
import { listConnections } from "@agentfactory/db";
```

Add near the bottom of the file, after `dedupeRepos`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentfactory/web test -- github-app`
Expected: PASS, all cases in both new `describe` blocks plus the existing ones.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @agentfactory/web typecheck`

```bash
git add apps/web/src/server/github-app.ts apps/web/src/server/__tests__/github-app.test.ts
git commit -m "feat(web): resolve a repo's default-branch sha from apps/web

Adds findInstallationForRepo and resolveDefaultBranchSha to
github-app.ts, mirroring apps/worker/src/scm-provider.ts's versions.
Needed by the upcoming /api/repos/map-status route so the web app can
answer \"is this repo mapped?\" without going through the worker.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `GET`/`POST /api/repos/map-status`

**Files:**
- Create: `apps/web/src/app/api/repos/map-status/route.ts`
- Test: `apps/web/src/app/api/repos/map-status/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `resolveDefaultBranchSha(orgId, repoFullName)` and (implicitly, via mock) `getRepoMap` from `@agentfactory/db`, `enqueueRepoMapWarmJob` from `@agentfactory/queue` (Task 1's ground truth: `enqueueRepoMapWarmJob(orgId: number, repoFullName: string): Promise<void>`, already exists in `packages/queue/src/index.ts`).
- Produces: `GET /api/repos/map-status?codebase=owner/repo` → `{ mapped: boolean, checkable: boolean }`. `POST /api/repos/map-status` with JSON body `{ codebase: string }` → `204` (best-effort, never surfaces a queue failure as an error — matches every other warm-trigger call site).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/app/api/repos/map-status/__tests__/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const resolveDefaultBranchShaMock = vi.fn();
const getRepoMapMock = vi.fn();
const enqueueRepoMapWarmJobMock = vi.fn();

vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));
vi.mock("@/server/github-app", () => ({
  resolveDefaultBranchSha: (...args: unknown[]) => resolveDefaultBranchShaMock(...args),
}));
// @agentfactory/db and @agentfactory/queue both throw at import when their env vars are unset,
// which they are in the unit test env — mock both out, same pattern as
// apps/web/src/app/api/tasks/__tests__/route.test.ts.
vi.mock("@agentfactory/db", () => ({ getRepoMap: (...args: unknown[]) => getRepoMapMock(...args) }));
vi.mock("@agentfactory/queue", () => ({
  enqueueRepoMapWarmJob: (...args: unknown[]) => enqueueRepoMapWarmJobMock(...args),
}));

import { GET, POST } from "../route";

function getRequest(codebase?: string) {
  const url = new URL("http://localhost/api/repos/map-status");
  if (codebase !== undefined) url.searchParams.set("codebase", codebase);
  return new Request(url);
}

function postRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/repos/map-status", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  requireAuthContextMock.mockReset().mockResolvedValue({ user: { id: 1 }, orgId: 3 });
  resolveDefaultBranchShaMock.mockReset();
  getRepoMapMock.mockReset();
  enqueueRepoMapWarmJobMock.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/repos/map-status", () => {
  it("401s when unauthenticated", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);
    const res = await GET(getRequest("acme/widgets"));
    expect(res.status).toBe(401);
  });

  it("400s when codebase is missing", async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(400);
  });

  it("reports checkable:false when the sha can't be resolved", async () => {
    resolveDefaultBranchShaMock.mockResolvedValue(undefined);
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: false, checkable: false });
    expect(getRepoMapMock).not.toHaveBeenCalled();
  });

  it("reports mapped:true on a cache hit", async () => {
    resolveDefaultBranchShaMock.mockResolvedValue("deadbeef");
    getRepoMapMock.mockResolvedValue({ content: "the map" });
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: true, checkable: true });
    expect(getRepoMapMock).toHaveBeenCalledWith(3, "acme/widgets", "deadbeef");
  });

  it("reports mapped:false, checkable:true on a cache miss", async () => {
    resolveDefaultBranchShaMock.mockResolvedValue("deadbeef");
    getRepoMapMock.mockResolvedValue(undefined);
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: false, checkable: true });
  });

  it("reports checkable:false rather than throwing when sha resolution rejects", async () => {
    resolveDefaultBranchShaMock.mockRejectedValue(new Error("GitHub API down"));
    const res = await GET(getRequest("acme/widgets"));
    await expect(res.json()).resolves.toEqual({ mapped: false, checkable: false });
  });
});

describe("POST /api/repos/map-status", () => {
  it("401s when unauthenticated", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);
    const res = await POST(postRequest({ codebase: "acme/widgets" }));
    expect(res.status).toBe(401);
  });

  it("400s when codebase is missing", async () => {
    const res = await POST(postRequest({}));
    expect(res.status).toBe(400);
  });

  it("triggers the warm job for the org's codebase and returns 204", async () => {
    const res = await POST(postRequest({ codebase: "acme/widgets" }));
    expect(res.status).toBe(204);
    expect(enqueueRepoMapWarmJobMock).toHaveBeenCalledExactlyOnceWith(3, "acme/widgets");
  });

  it("still returns 204 when the queue is down", async () => {
    enqueueRepoMapWarmJobMock.mockRejectedValue(new Error("redis down"));
    const res = await POST(postRequest({ codebase: "acme/widgets" }));
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentfactory/web test -- map-status`
Expected: FAIL — `../route` does not exist.

- [ ] **Step 3: Implement the route**

Create `apps/web/src/app/api/repos/map-status/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getRepoMap } from "@agentfactory/db";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { requireAuthContext } from "@/server/auth";
import { resolveDefaultBranchSha } from "@/server/github-app";

// Answers "is this repo mapped for its current commit?" for the task-creation and task-edit
// forms' wait-choice banner (see docs/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md).
// checkable:false means "couldn't determine" (no GitHub connection, API error) — every caller
// treats that identically to "not mapped, but skip the prompt", never as an error to surface.
export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const repoFullName = new URL(request.url).searchParams.get("codebase");
  if (!repoFullName) return NextResponse.json({ error: "codebase is required" }, { status: 400 });

  const sha = await resolveDefaultBranchSha(ctx.orgId, repoFullName).catch(() => undefined);
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentfactory/web test -- map-status`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @agentfactory/web typecheck`

```bash
git add apps/web/src/app/api/repos/map-status/
git commit -m "feat(web): add GET/POST /api/repos/map-status

Lets the frontend ask whether a codebase is mapped for its current
commit, and trigger the warm job ahead of a task actually being
created or saved. Backs the upcoming wait-choice banner.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: i18n strings

**Files:**
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts`

**Interfaces:**
- Produces: new keys under `tasks.repoMapWait.*`, consumed by Task 4's component via `t("tasks.repoMapWait.<key>")`. `TranslationKey` (in `apps/web/src/lib/i18n/paths.ts`) is derived from this file's shape, so adding these keys here is what makes them valid `t()` arguments elsewhere — no other file needs editing for this step.

- [ ] **Step 1: Add the strings**

In `apps/web/src/lib/i18n/dictionaries/en.ts`, inside the `tasks:` object, add a `repoMapWait` key as a sibling of `create` and `edit`:

```ts
    repoMapWait: {
      title: "This repo hasn't been mapped yet",
      body: "Mapping takes about 30 seconds and helps the agent orient faster. Skipping it means the agent spends time — and cost — exploring the codebase manually first.",
      waitAndCreate: "Wait for the map, then create task",
      waitAndSave: "Wait for the map, then save",
      startNow: "Start now without it",
      waitingTitle: "Preparing repo context…",
      waitingBody: "Usually takes about 30 seconds. You can keep waiting, or start now without the extra context.",
      escapeHatch: "Never mind, start without it",
      enqueueFailed: "Couldn't start mapping — continuing without it.",
      pollFailed: "Couldn't check on the map — continuing without it.",
    },
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: PASS — this only adds keys, so nothing existing can break, but this confirms `TranslationKey` picked up the new paths (Task 4 relies on that for compile-time key checking).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): add i18n strings for the repo-map wait-choice banner

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `useRepoMapWaitGate` hook

**Files:**
- Create: `apps/web/src/lib/use-repo-map-wait-gate.ts`
- Test: `apps/web/src/lib/__tests__/use-repo-map-wait-gate.test.ts`

**Interfaces:**
- Consumes: `apiFetch<T>(path, init)` from `apps/web/src/lib/api-client.ts` (existing).
- Produces:
  ```ts
  export type RepoMapGateState = "hidden" | "checking" | "prompt" | "waiting";
  export interface RepoMapWaitGate {
    state: RepoMapGateState;
    fallbackMessage: string | null; // one of "enqueue-failed" | "poll-failed", or null
    startWaiting: () => void;
    startNow: () => void;
  }
  export function useRepoMapWaitGate(codebase: string, onProceed: () => void): RepoMapWaitGate;
  ```
  Task 5's `RepoMapWaitBanner` renders based on `state`/`fallbackMessage` and calls `startWaiting`/`startNow`. Tasks 6/7's pages call `onProceed` to mean "it's fine to submit now" and gate their own submit on `state !== "prompt" && state !== "waiting"`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/__tests__/use-repo-map-wait-gate.test.ts`:

```ts
// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

import { useRepoMapWaitGate } from "../use-repo-map-wait-gate";

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

it("stays hidden when there is no codebase", () => {
  const { result } = renderHook(() => useRepoMapWaitGate("", vi.fn()));
  expect(result.current.state).toBe("hidden");
  expect(apiFetchMock).not.toHaveBeenCalled();
});

it("goes hidden after a checkable, mapped result", async () => {
  apiFetchMock.mockResolvedValue({ mapped: true, checkable: true });
  const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
  expect(result.current.state).toBe("checking");
  await waitFor(() => expect(result.current.state).toBe("hidden"));
  expect(apiFetchMock).toHaveBeenCalledWith("/api/repos/map-status?codebase=acme%2Fwidgets");
});

it("goes hidden when the initial check isn't checkable", async () => {
  apiFetchMock.mockResolvedValue({ mapped: false, checkable: false });
  const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
  await waitFor(() => expect(result.current.state).toBe("hidden"));
});

it("goes hidden when the initial check throws", async () => {
  apiFetchMock.mockRejectedValue(new Error("network error"));
  const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
  await waitFor(() => expect(result.current.state).toBe("hidden"));
});

it("shows the prompt on a checkable miss", async () => {
  apiFetchMock.mockResolvedValue({ mapped: false, checkable: true });
  const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", vi.fn()));
  await waitFor(() => expect(result.current.state).toBe("prompt"));
});

describe("startNow", () => {
  it("hides the banner and calls onProceed immediately", async () => {
    apiFetchMock.mockResolvedValue({ mapped: false, checkable: true });
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    await waitFor(() => expect(result.current.state).toBe("prompt"));

    act(() => result.current.startNow());

    expect(result.current.state).toBe("hidden");
    expect(onProceed).toHaveBeenCalledOnce();
  });
});

describe("startWaiting", () => {
  it("triggers the warm job, polls, and calls onProceed once mapped", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // initial check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // poll 1: still miss
      .mockResolvedValueOnce({ mapped: true, checkable: true }); // poll 2: hit
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    await waitFor(() => expect(result.current.state).toBe("prompt"));

    await act(async () => result.current.startWaiting());
    expect(result.current.state).toBe("waiting");
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/repos/map-status",
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.state).toBe("waiting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.state).toBe("hidden");
  });

  it("falls back to startNow when triggering the warm job fails", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // initial check
      .mockRejectedValueOnce(new Error("redis down")); // POST trigger warm fails
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    await waitFor(() => expect(result.current.state).toBe("prompt"));

    await act(async () => result.current.startWaiting());
    await waitFor(() => expect(onProceed).toHaveBeenCalledOnce());
    expect(result.current.state).toBe("hidden");
    expect(result.current.fallbackMessage).toBe("enqueue-failed");
  });

  it("falls back to startNow after repeated poll failures", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ mapped: false, checkable: true }) // initial check
      .mockResolvedValueOnce(undefined) // POST trigger warm
      .mockRejectedValueOnce(new Error("network")) // poll 1
      .mockRejectedValueOnce(new Error("network")) // poll 2
      .mockRejectedValueOnce(new Error("network")); // poll 3 -> give up
    const onProceed = vi.fn();
    const { result } = renderHook(() => useRepoMapWaitGate("acme/widgets", onProceed));
    await waitFor(() => expect(result.current.state).toBe("prompt"));

    await act(async () => result.current.startWaiting());
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
    }
    expect(onProceed).toHaveBeenCalledOnce();
    expect(result.current.fallbackMessage).toBe("poll-failed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentfactory/web test -- use-repo-map-wait-gate`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook**

Create `apps/web/src/lib/use-repo-map-wait-gate.ts`:

```ts
"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface MapStatusResponse {
  mapped: boolean;
  checkable: boolean;
}

export type RepoMapGateState = "hidden" | "checking" | "prompt" | "waiting";
export type RepoMapWaitFallback = "enqueue-failed" | "poll-failed";

export interface RepoMapWaitGate {
  state: RepoMapGateState;
  fallbackMessage: RepoMapWaitFallback | null;
  startWaiting: () => void;
  startNow: () => void;
}

const POLL_INTERVAL_MS = 2500;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

function fetchStatus(codebase: string): Promise<MapStatusResponse> {
  return apiFetch<MapStatusResponse>(`/api/repos/map-status?codebase=${encodeURIComponent(codebase)}`);
}

// Drives the wait-choice banner's state machine, shared by the task-creation and task-edit
// forms. See docs/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md. `onProceed` is
// called exactly once per "it's fine to submit now" moment: a checkable+mapped initial check, a
// poll landing, or either fallback path — the caller (a form's submit handler) decides what
// "proceed" means (POST vs PATCH).
export function useRepoMapWaitGate(codebase: string, onProceed: () => void): RepoMapWaitGate {
  const [state, setState] = useState<RepoMapGateState>("hidden");
  const [fallbackMessage, setFallbackMessage] = useState<RepoMapWaitFallback | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestIdRef = useRef(0);
  const onProceedRef = useRef(onProceed);
  onProceedRef.current = onProceed;

  function stopPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  // Re-check whenever the codebase changes, discarding any earlier prompt/waiting state for a
  // previous selection. requestIdRef guards against a stale response landing after the user
  // has already changed the selection again.
  useEffect(() => {
    stopPolling();
    setFallbackMessage(null);
    const requestId = ++requestIdRef.current;
    if (!codebase) {
      setState("hidden");
      return;
    }
    setState("checking");
    fetchStatus(codebase)
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setState(result.checkable && !result.mapped ? "prompt" : "hidden");
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) return;
        setState("hidden");
      });
    return () => {
      requestIdRef.current += 1;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codebase]);

  useEffect(() => stopPolling, []);

  function startNow() {
    stopPolling();
    setState("hidden");
    onProceedRef.current();
  }

  function startWaiting() {
    setState("waiting");
    setFallbackMessage(null);

    apiFetch("/api/repos/map-status", { method: "POST", body: JSON.stringify({ codebase }) }).catch(() => {
      setFallbackMessage("enqueue-failed");
      startNow();
    });

    let consecutiveFailures = 0;
    pollTimerRef.current = setInterval(() => {
      fetchStatus(codebase)
        .then((result) => {
          consecutiveFailures = 0;
          if (result.mapped) startNow();
        })
        .catch(() => {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            setFallbackMessage("poll-failed");
            startNow();
          }
        });
    }, POLL_INTERVAL_MS);
  }

  return { state, fallbackMessage, startWaiting, startNow };
}
```

Note: `startNow` intentionally does double duty as "user clicked start now," "poll landed a hit," and "give up after a failure" — in every case the banner disappears and `onProceed` fires once. This matches the spec's error-handling table exactly (each failure path "falls through to Start now automatically").

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentfactory/web test -- use-repo-map-wait-gate`
Expected: PASS, all cases. If the fake-timer poll tests are flaky, double check `vi.advanceTimersByTimeAsync` is awaited inside `act` — this is required for the microtasks from `apiFetch` mocks to flush between timer ticks.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @agentfactory/web typecheck`

```bash
git add apps/web/src/lib/use-repo-map-wait-gate.ts apps/web/src/lib/__tests__/use-repo-map-wait-gate.test.ts
git commit -m "feat(web): add useRepoMapWaitGate hook

State machine behind the repo-map wait-choice banner: checks whether a
selected codebase is mapped, and on a miss lets the caller either
proceed immediately or wait (triggering the warm job and polling)
with an automatic fallback to proceeding on any failure.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `RepoMapWaitBanner` component

**Files:**
- Create: `apps/web/src/components/RepoMapWaitBanner.tsx`
- Test: `apps/web/src/components/__tests__/RepoMapWaitBanner.test.tsx`

**Interfaces:**
- Consumes: `RepoMapWaitGate` (Task 4's return type), `Button` from `@agentfactory/shared`, `useTranslation()` from `apps/web/src/lib/i18n/context`.
- Produces: `RepoMapWaitBanner({ gate: RepoMapWaitGate; submitVerb: "create" | "save" }): JSX.Element | null` — exported from `apps/web/src/components/RepoMapWaitBanner.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/__tests__/RepoMapWaitBanner.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { RepoMapWaitBanner } from "../RepoMapWaitBanner";
import type { RepoMapWaitGate } from "../../lib/use-repo-map-wait-gate";

function gate(overrides: Partial<RepoMapWaitGate>): RepoMapWaitGate {
  return { state: "hidden", fallbackMessage: null, startWaiting: vi.fn(), startNow: vi.fn(), ...overrides };
}

function renderBanner(g: RepoMapWaitGate, submitVerb: "create" | "save" = "create") {
  return render(
    <I18nProvider>
      <RepoMapWaitBanner gate={g} submitVerb={submitVerb} />
    </I18nProvider>,
  );
}

describe("RepoMapWaitBanner", () => {
  it("renders nothing when hidden", () => {
    const { container } = renderBanner(gate({ state: "hidden" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while checking", () => {
    const { container } = renderBanner(gate({ state: "checking" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the prompt with both choices on a miss", () => {
    renderBanner(gate({ state: "prompt" }));
    expect(screen.getByText("This repo hasn't been mapped yet")).toBeInTheDocument();
    expect(screen.getByText("Wait for the map, then create task")).toBeInTheDocument();
    expect(screen.getByText("Start now without it")).toBeInTheDocument();
  });

  it("uses save-flavored copy on the edit page", () => {
    renderBanner(gate({ state: "prompt" }), "save");
    expect(screen.getByText("Wait for the map, then save")).toBeInTheDocument();
  });

  it("calls startWaiting when the wait button is clicked", () => {
    const startWaiting = vi.fn();
    renderBanner(gate({ state: "prompt", startWaiting }));
    fireEvent.click(screen.getByText("Wait for the map, then create task"));
    expect(startWaiting).toHaveBeenCalledOnce();
  });

  it("calls startNow when the start-now button is clicked", () => {
    const startNow = vi.fn();
    renderBanner(gate({ state: "prompt", startNow }));
    fireEvent.click(screen.getByText("Start now without it"));
    expect(startNow).toHaveBeenCalledOnce();
  });

  it("shows the waiting state with the escape hatch", () => {
    renderBanner(gate({ state: "waiting" }));
    expect(screen.getByText("Preparing repo context…")).toBeInTheDocument();
    expect(screen.getByText("Never mind, start without it")).toBeInTheDocument();
  });

  it("shows the fallback message instead of the default waiting copy when set", () => {
    renderBanner(gate({ state: "waiting", fallbackMessage: "poll-failed" }));
    expect(screen.getByText("Couldn't check on the map — continuing without it.")).toBeInTheDocument();
  });

  it("calls startNow from the escape hatch", () => {
    const startNow = vi.fn();
    renderBanner(gate({ state: "waiting", startNow }));
    fireEvent.click(screen.getByText("Never mind, start without it"));
    expect(startNow).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentfactory/web test -- RepoMapWaitBanner`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/RepoMapWaitBanner.tsx`:

```tsx
"use client";

import { Button } from "@agentfactory/shared";
import { useTranslation } from "@/lib/i18n/context";
import type { RepoMapWaitGate } from "@/lib/use-repo-map-wait-gate";

interface RepoMapWaitBannerProps {
  gate: RepoMapWaitGate;
  submitVerb: "create" | "save";
}

// Renders the two states from docs/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md's
// approved mockups: the decision prompt, and the waiting screen with its escape hatch. Shared by
// both the task-creation and task-edit forms — `submitVerb` only changes the wait button's copy.
export function RepoMapWaitBanner({ gate, submitVerb }: RepoMapWaitBannerProps) {
  const { t } = useTranslation();

  if (gate.state === "hidden" || gate.state === "checking") return null;

  if (gate.state === "prompt") {
    return (
      <div style={bannerStyle}>
        <p style={{ margin: "0 0 6px 0", fontWeight: 600 }}>{t("tasks.repoMapWait.title")}</p>
        <p style={{ margin: "0 0 12px 0", fontSize: 13, opacity: 0.85 }}>{t("tasks.repoMapWait.body")}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <Button type="button" variant="primary" onClick={gate.startWaiting}>
            {t(submitVerb === "create" ? "tasks.repoMapWait.waitAndCreate" : "tasks.repoMapWait.waitAndSave")}
          </Button>
          <Button type="button" variant="secondary" onClick={gate.startNow}>
            {t("tasks.repoMapWait.startNow")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={bannerStyle}>
      <p style={{ margin: "0 0 8px 0", fontWeight: 600 }}>{t("tasks.repoMapWait.waitingTitle")}</p>
      <p style={{ margin: "0 0 12px 0", fontSize: 13, opacity: 0.85 }}>
        {gate.fallbackMessage
          ? t(`tasks.repoMapWait.${gate.fallbackMessage === "enqueue-failed" ? "enqueueFailed" : "pollFailed"}`)
          : t("tasks.repoMapWait.waitingBody")}
      </p>
      <Button type="button" variant="secondary" onClick={gate.startNow}>
        {t("tasks.repoMapWait.escapeHatch")}
      </Button>
    </div>
  );
}

const bannerStyle: React.CSSProperties = {
  border: "1px solid var(--color-neutral-700)",
  borderRadius: "var(--radius-md)",
  padding: 14,
  background: "var(--color-surface)",
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentfactory/web test -- RepoMapWaitBanner`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @agentfactory/web typecheck`

```bash
git add apps/web/src/components/RepoMapWaitBanner.tsx apps/web/src/components/__tests__/RepoMapWaitBanner.test.tsx
git commit -m "feat(web): add RepoMapWaitBanner component

Presentational component for the wait-choice banner and waiting
screen approved in docs/superpowers/specs/2026-09-05-repo-map-wait-
choice-design.md's mockups. Shared by the task-creation and
task-edit forms via useRepoMapWaitGate.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire into the task-creation form

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/new/page.tsx`

**Interfaces:**
- Consumes: `useRepoMapWaitGate` (Task 4), `RepoMapWaitBanner` (Task 5).

- [ ] **Step 1: Extract the real submit logic and gate it**

In `apps/web/src/app/(app)/tasks/new/page.tsx`:

1. Add the imports:
   ```ts
   import { useRepoMapWaitGate } from "@/lib/use-repo-map-wait-gate";
   import { RepoMapWaitBanner } from "@/components/RepoMapWaitBanner";
   ```

2. Rename the existing `handleSubmit` function to `doSubmit` and drop its `e: React.FormEvent` parameter and the `e.preventDefault()` line at its top (the surrounding `if (!title.trim()) return;` line stays):

   ```ts
   async function doSubmit() {
     if (!title.trim()) return;
     setSubmitting(true);
     try {
       // ...unchanged body...
     } finally {
       setSubmitting(false);
     }
   }
   ```

3. Add the gate hook right after the `codebase` computation (which already exists a few lines above where `handleAssigneeChange` is defined):

   ```ts
   const gate = useRepoMapWaitGate(codebase, () => void doSubmit());
   const gateBlocking = gate.state === "prompt" || gate.state === "waiting";
   ```

4. Add a new `handleSubmit` that the `<form>`'s `onSubmit` calls, deferring to the gate when it's blocking:

   ```ts
   function handleSubmit(e: React.FormEvent) {
     e.preventDefault();
     if (gateBlocking) return;
     void doSubmit();
   }
   ```

5. In the JSX, render the banner right after the codebase `<Field>` block (after the closing `</Field>` that follows the `{!reposLoading && repos.length === 0 && (...)}` block, still inside the `<div style={{ display: "grid", ...}}>` grid — place it as a sibling `<div style={{ gridColumn: "1 / -1" }}>` so it spans both columns rather than squeezing into the codebase column's half-width):

   ```tsx
   <div style={{ gridColumn: "1 / -1" }}>
     <RepoMapWaitBanner gate={gate} submitVerb="create" />
   </div>
   ```

6. Disable the submit button while the gate is blocking, so a click can't race ahead of the banner's own buttons:

   ```tsx
   <Button variant="primary" type="submit" disabled={!title.trim() || submitting || gateBlocking}>
   ```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verification**

Run: `pnpm --filter @agentfactory/web dev`, open `/tasks/new`, select a repo with no cached map (any repo the mock GitHub connection lists, assuming its default-branch sha has no `repo_maps` row). Confirm: banner appears below the codebase field; "Start now without it" submits immediately; "Wait for the map, then create task" shows the waiting screen and the escape hatch works.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/tasks/new/page.tsx"
git commit -m "feat(web): wire the repo-map wait-choice banner into task creation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire into the task-edit page

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx`

**Interfaces:**
- Consumes: same as Task 6.

- [ ] **Step 1: Extract the real submit logic and gate it**

In `apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx`:

1. Add the same two imports as Task 6.

2. Rename `handleSubmit` to `doSubmit`, dropping its `e` parameter, `e.preventDefault()`, and the `if (!task) return;` guard's `e`-dependence (keep the guard itself — `task` can still be falsy if this fires before the task loads):

   ```ts
   async function doSubmit() {
     if (!task) return;
     setSubmitting(true);
     try {
       // ...unchanged body...
     } finally {
       setSubmitting(false);
     }
   }
   ```

3. Add the gate — note this hook must be called unconditionally before the `if (!task) return <div>...</div>;` early return a few lines above it in the current file, so move the gate hook call to sit alongside the other `useState`/`useEffect` calls near the top of the component, before that early return:

   ```ts
   const gate = useRepoMapWaitGate(codebase, () => void doSubmit());
   const gateBlocking = gate.state === "prompt" || gate.state === "waiting";
   ```

4. Add the new `handleSubmit`:

   ```ts
   function handleSubmit(e: React.FormEvent) {
     e.preventDefault();
     if (gateBlocking) return;
     void doSubmit();
   }
   ```

5. In the JSX, render the banner after the codebase `<Field>`'s grid block, same placement pattern as Task 6:

   ```tsx
   <div style={{ gridColumn: "1 / -1" }}>
     <RepoMapWaitBanner gate={gate} submitVerb="save" />
   </div>
   ```

6. Disable the submit button while blocking:

   ```tsx
   <Button variant="primary" type="submit" disabled={submitting || gateBlocking}>
   ```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agentfactory/web typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verification**

Run: `pnpm --filter @agentfactory/web dev`, open a task with no session yet, go to its edit page, set its codebase to an uncached repo, confirm the same banner/waiting/escape-hatch behavior as Task 6, and that "save" copy is used instead of "create task."

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/(app)/tasks/[taskId]/edit/page.tsx"
git commit -m "feat(web): wire the repo-map wait-choice banner into task editing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification and push

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm --filter @agentfactory/web test`
Expected: PASS, including every test added in Tasks 1–5 plus all pre-existing tests.

- [ ] **Step 2: Run typecheck and lint across the whole repo**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Push the branch and open a PR**

```bash
git push -u origin repo-map-wait-choice
gh pr create --repo or-borco/AgentFactory \
  --title "feat(web): let users choose to wait for the repo map at task creation/edit" \
  --body "$(cat <<'EOF'
Closes the gap identified in [PR #156's review](https://github.com/or-borco/AgentFactory/pull/156#issuecomment-5540054191): a task run immediately after creation could not be helped by a 20s poll when generation measures 33-38s. Rather than guessing a bigger constant, this surfaces the tradeoff explicitly wherever a codebase gets set — the "New Task" form and the task edit page, confirmed to be the only two paths that exist today (no external API, no other caller).

Design: `docs/superpowers/specs/2026-09-05-repo-map-wait-choice-design.md`

## What changed

- `apps/web/src/server/github-app.ts`: added `findInstallationForRepo` / `resolveDefaultBranchSha`, mirroring the worker's existing versions, so the web app can check cache status itself.
- New `GET`/`POST /api/repos/map-status`: is a repo mapped for its current commit, and trigger the warm job ahead of the form actually submitting.
- New `useRepoMapWaitGate` hook + `RepoMapWaitBanner` component, shared by both forms: shows the tradeoff on an uncached repo, lets the user wait (polling until ready, with an escape hatch) or proceed immediately.
- Wired into `tasks/new/page.tsx` and `tasks/[taskId]/edit/page.tsx` — the only two places a task's codebase can be set today.

## Not in this PR

PR #156's poll (`ensureRepoMap`'s `CACHE_POLL_TIMEOUT_MS`) stays as-is — removing it is a deliberate, separate follow-up once this ships, so there's never a gap with zero mitigation. See that PR's updated description and the design spec's "What's left for PR #156's poll to cover."

## Testing

Unit tests for every new function/route/hook/component (see individual commits). `pnpm typecheck` and `pnpm lint` pass across the repo.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opens successfully; report the URL back.
