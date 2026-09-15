# PR Review Agents Post GitHub Comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** when a task's description contains a GitHub PR link, running it produces a real GitHub
review — inline comments anchored to files/lines, plus a summary and a Comment/Request-changes
verdict — instead of only a run transcript.

**Architecture:** the worker detects a review run the same way it already detects a linked GitHub
*issue* — live regex parsing of `task.description`, nothing persisted. A review run checks out
the PR's head ref instead of creating a dev branch, asks the agent for a structured (JSON) review
via the SDK's native `outputFormat`, validates every comment's file/line against the real PR
diff, and posts one GitHub review after the turn. A new `pr_reviews` table records what was
posted, and the task page reads the latest row to show a "Review" block.

**Tech Stack:** TypeScript, Next.js 16 App Router, Drizzle/Postgres, BullMQ/Redis, Docker sandbox,
`@anthropic-ai/claude-agent-sdk`, Vitest.

## Global Constraints

- Spec: [docs/superpowers/specs/2026-09-15-pr-review-github-comments-design.md](../specs/2026-09-15-pr-review-github-comments-design.md).
- No new field on `Task`. Detection is live parsing, every run — no persisted "is this a review" flag.
- No `triggers` table, no webhooks, no policy engine, no `ToolPolicy` enforcement, no `approve`
  verdict, no merge-blocking check run.
- The sandbox never receives a GitHub token. All GitHub writes happen host-side, after the turn.
- `packages/scm` (the `ScmProvider` port) may only contain pure API calls — no `SandboxProvider`
  or sandbox-exec types, which live in `apps/worker` and are not importable from a package.
  Sandbox-side git operations for review runs go in a new `apps/worker/src/pr-review.ts`,
  mirroring how `cloneIntoSandbox`/`pushChangesIfDirty` already live in `apps/worker/src/scm-
  provider.ts` rather than on the port.
- Diff text shown to the agent is capped at 120,000 characters (`MAX_REVIEW_DIFF_CHARS`), matching
  `eval-judge.ts`'s existing `MAX_ARTEFACT_CHARS` pattern.
- Follow existing repo conventions throughout: Drizzle repositories return `@agentfactory/core`
  domain types via a `toX` mapper (see `packages/db/src/repositories/run-evals.ts`); db-integration
  tests import `../setup.js` and use `packages/db/src/__tests__/fixtures.ts`; worker-level modules
  that shell out are tested with a `fakeSandbox` stub (see `apps/worker/src/__tests__/agent-
  runtime.test.ts`); i18n strings are added to `en.ts` only, the `TranslationKey` type updates
  automatically.
- Run `pnpm typecheck` and the relevant test project after each task.

---

### Task 1: `packages/core` — a "review" artifact kind

**Files:**
- Modify: `packages/core/src/events.ts` (`ArtifactEvent.artifactType`)
- Modify: `packages/core/src/domain.ts` (`Artifact.type`)

**Interfaces:**
- Produces: `ArtifactEvent.artifactType` and `Artifact.type` both admit `"review"` alongside the
  existing `"pr" | "diff" | "file" | "report"`.

- [ ] **Step 1: Widen both unions**

In `packages/core/src/events.ts`:

```ts
export interface ArtifactEvent extends RunEventBase {
  type: "artifact";
  artifactType: "pr" | "diff" | "file" | "report" | "review";
  label: string;
  url?: string;
}
```

In `packages/core/src/domain.ts`:

```ts
export interface Artifact {
  id: ID;
  runId: ID;
  type: "pr" | "diff" | "file" | "report" | "review";
  label: string;
  url?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agentfactory/core typecheck`
Expected: PASS (no other file switches exhaustively on these unions — confirmed by grep, nothing
else needs updating).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/events.ts packages/core/src/domain.ts
git commit -m "feat(core): add a 'review' artifact kind for PR review runs"
```

---

### Task 2: `packages/scm` — PR-review methods on the `ScmProvider` port

**Files:**
- Modify: `packages/scm/src/types.ts`
- Modify: `packages/scm/src/github.ts`
- Modify: `packages/scm/src/registry.ts`
- Modify: `packages/scm/src/index.ts`
- Test: `packages/scm/src/__tests__/github.test.ts` (extend existing)
- Test: `packages/scm/src/__tests__/registry.test.ts` (extend existing)

**Interfaces:**
- Consumes: `Connection`, `ConnectionProvider` from `@agentfactory/core`; existing `CloneTarget`,
  `ScmProvider`, `installationIdOf`-style helpers already in `github.ts`.
- Produces (new, exported from `@agentfactory/scm`):
  - `ScmProvider.fetchPullRequest(connection, repoFullName, prNumber): Promise<PullRequestInfo>`
  - `ScmProvider.fetchReviewThreads(connection, repoFullName, prNumber): Promise<ReviewComment[]>`
  - `ScmProvider.postReview(connection, repoFullName, prNumber, review): Promise<PostedReview>`
  - `ScmProvider.parsePullRequestReference(text): { repoFullName, prNumber } | undefined`
  - `parsePullRequestReferenceAcrossProviders(text): { repoFullName, prNumber, provider } | undefined`
  - Types `PullRequestInfo`, `ReviewComment`, `ReviewToPost`, `PostedReview`.

- [ ] **Step 1: Add the new types and port methods to `types.ts`**

```ts
export interface PullRequestInfo {
  state: "open" | "closed" | "merged";
  baseBranch: string;
  headSha: string;
  title: string;
  body: string;
}

// A single inline comment already on the PR — the agent's own prior comments plus any human
// replies, injected into a re-review's prompt so it doesn't repeat itself. v1 keeps this flat
// (no thread grouping); GitHub's REST comments list is flat too.
export interface ReviewComment {
  path: string;
  line: number | null;
  body: string;
  author: string;
  createdAt: string;
}

export interface ReviewToPost {
  summary: string;
  verdict: "comment" | "request_changes";
  comments: Array<{ path: string; line: number; body: string }>;
}

export interface PostedReview {
  id: string;
  url: string;
  // What GitHub actually accepted — differs from the requested verdict only when the
  // own-PR "can not request changes on your own pull request" fallback fired.
  postedAs: "comment" | "request_changes";
}
```

Add to the `ScmProvider` interface, after `parseIssueReference`:

```ts
  fetchPullRequest(connection: Connection, repoFullName: string, prNumber: number): Promise<PullRequestInfo>;
  fetchReviewThreads(connection: Connection, repoFullName: string, prNumber: number): Promise<ReviewComment[]>;
  postReview(
    connection: Connection,
    repoFullName: string,
    prNumber: number,
    review: ReviewToPost,
  ): Promise<PostedReview>;
  parsePullRequestReference(text: string): { repoFullName: string; prNumber: number } | undefined;
```

- [ ] **Step 2: Write the failing tests for the GitHub adapter**

Append to `packages/scm/src/__tests__/github.test.ts` (same file the existing `fetchIssue`/
`openDraftPullRequest` tests live in — follow its exact `vi.stubGlobal("fetch", ...)` /
`githubConnection(id, installationId)` helper pattern already in that file):

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @agentfactory/scm test`
Expected: FAIL — `fetchPullRequest`/`fetchReviewThreads`/`postReview`/`parsePullRequestReference`
are not implemented on `githubScmProvider`.

- [ ] **Step 4: Implement the four methods on `githubScmProvider` in `github.ts`**

Add this constant near `ISSUE_URL_RE`:

```ts
const PR_URL_RE = /github\.com\/([^/\s]+\/[^/\s.]+)\/pull\/(\d+)/;
```

Add these methods to the `githubScmProvider` object literal, after `openDraftPullRequest`:

```ts
  async fetchPullRequest(connection, repoFullName, prNumber) {
    const token = await getInstallationToken(installationIdOf(connection));
    const res = await fetch(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`GitHub API PR fetch failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const pr = (await res.json()) as {
      state: "open" | "closed";
      merged: boolean;
      base: { ref: string };
      head: { sha: string };
      title: string;
      body: string | null;
    };
    return {
      state: pr.merged ? "merged" : pr.state,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      title: pr.title,
      body: pr.body ?? "",
    };
  },

  // Flat list of inline review comments — GitHub's REST endpoint doesn't group into threads;
  // v1 doesn't need it to (see ReviewComment's own comment).
  async fetchReviewThreads(connection, repoFullName, prNumber) {
    const token = await getInstallationToken(installationIdOf(connection));
    const res = await fetch(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}/comments?per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`GitHub API PR comments fetch failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const comments = (await res.json()) as Array<{
      path: string;
      line: number | null;
      original_line: number | null;
      body: string;
      user: { login: string } | null;
      created_at: string;
    }>;
    return comments.map((c) => ({
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      body: c.body,
      author: c.user?.login ?? "unknown",
      createdAt: c.created_at,
    }));
  },

  // Posts a review. Comment-only verdicts always go through as COMMENT. A request_changes
  // verdict is attempted as REQUEST_CHANGES first; GitHub rejects that with a 422 when the
  // reviewing identity also opened the PR ("can not request changes on your own pull
  // request") — rather than detecting that case ahead of time, this just tries and falls back
  // to a COMMENT with an explicit warning header, so postedAs always reflects what actually
  // landed on GitHub.
  async postReview(connection, repoFullName, prNumber, review) {
    const token = await getInstallationToken(installationIdOf(connection));
    const commentsPayload = review.comments.map((c) => ({ path: c.path, line: c.line, body: c.body }));

    const post = (event: "COMMENT" | "REQUEST_CHANGES", body: string) =>
      fetch(`${GITHUB_API}/repos/${repoFullName}/pulls/${prNumber}/reviews`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body, event, comments: commentsPayload }),
      });

    const asPosted = async (res: Response, postedAs: "comment" | "request_changes") => {
      if (!res.ok) {
        throw new Error(`GitHub API review post failed: ${res.status} ${await res.text().catch(() => "")}`);
      }
      const posted = (await res.json()) as { id: number; html_url: string };
      return { id: String(posted.id), url: posted.html_url, postedAs };
    };

    if (review.verdict === "comment") {
      return asPosted(await post("COMMENT", review.summary), "comment");
    }

    const res = await post("REQUEST_CHANGES", review.summary);
    if (res.status === 422) {
      const bodyText = await res.text().catch(() => "");
      if (/own pull request/i.test(bodyText)) {
        return asPosted(await post("COMMENT", `⛔ Changes requested\n\n${review.summary}`), "comment");
      }
      throw new Error(`GitHub API review post failed: 422 ${bodyText}`);
    }
    return asPosted(res, "request_changes");
  },

  // Sibling to parseIssueReference — same shape, /pull/ instead of /issues/.
  parsePullRequestReference(text) {
    const match = PR_URL_RE.exec(text);
    if (!match) return undefined;
    return { repoFullName: match[1], prNumber: Number(match[2]) };
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @agentfactory/scm test`
Expected: PASS

- [ ] **Step 6: Dispatch `parsePullRequestReference` across providers in `registry.ts`**

Add to `packages/scm/src/registry.ts`, mirroring `parseIssueReferenceAcrossProviders`:

```ts
export function parsePullRequestReferenceAcrossProviders(
  text: string,
): { repoFullName: string; prNumber: number; provider: ConnectionProvider } | undefined {
  for (const provider of providers) {
    const match = provider.parsePullRequestReference(text);
    if (match) return { ...match, provider: provider.id };
  }
  return undefined;
}
```

Add the equivalent failing/passing test to `packages/scm/src/__tests__/registry.test.ts`
(mirror whatever test already exists there for `parseIssueReferenceAcrossProviders`, swapping in
a stub provider's `parsePullRequestReference`).

- [ ] **Step 7: Export everything from `packages/scm/src/index.ts`**

```ts
export * from "./types";
export { githubScmProvider } from "./github";
export {
  getScmProvider,
  resolveScmConnection,
  parseIssueReferenceAcrossProviders,
  parsePullRequestReferenceAcrossProviders,
} from "./registry";
```

- [ ] **Step 8: Run the full package test suite and typecheck**

Run: `pnpm --filter @agentfactory/scm test && pnpm --filter @agentfactory/scm typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/scm
git commit -m "feat(scm): add PR-review methods to the ScmProvider port

fetchPullRequest, fetchReviewThreads, postReview, and parsePullRequestReference
(dispatched across providers via parsePullRequestReferenceAcrossProviders),
implemented for GitHub. postReview handles the 'can not request changes on
your own pull request' 422 by falling back to a flagged Comment review."
```

---

### Task 3: `packages/db` — the `pr_reviews` table

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/repositories/pr-reviews.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/__tests__/repositories/pr-reviews.test.ts`
- Generated: a new file under `packages/db/drizzle/` (via `db:generate`, not hand-written)

**Interfaces:**
- Consumes: `orgs`, `tasks`, `runs` tables already in `schema.ts`.
- Produces: `PrReview` type; `createPrReview`, `getLatestPrReview(taskId, orgId)`,
  `listPrReviewsForTask(taskId, orgId)` from `@agentfactory/db`.

- [ ] **Step 1: Add the `pr_reviews` table to `schema.ts`**

Add near `runEvals` (after it), following its exact denormalized-`org_id` + indexed pattern:

```ts
export const reviewVerdictEnum = pgEnum("review_verdict", ["comment", "request_changes"]);

// One row per review pass actually posted to GitHub — deliberately its own table, never columns
// on runs, for the same reason run_evals is: the task page polls runs on a ~1.5s timer, and
// "latest review for task X" / "last reviewed head_sha for task X" are both single indexed
// lookups here instead. There is no persisted field on tasks identifying it as a review — see
// parsePullRequestReference — so repo_full_name/pr_number are stored here, not looked up
// elsewhere.
export const prReviews = pgTable(
  "pr_reviews",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    verdict: reviewVerdictEnum("verdict").notNull(),
    postedAs: reviewVerdictEnum("posted_as").notNull(),
    githubReviewId: text("github_review_id").notNull(),
    url: text("url").notNull(),
    commentCount: integer("comment_count").notNull().default(0),
    truncated: boolean("truncated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // getLatestPrReview/listPrReviewsForTask both filter WHERE task_id = ? ORDER BY created_at
    // desc — without this, every task-page Review-block fetch is a sequential scan.
    index("pr_reviews_task_id_created_at_idx").on(table.taskId, table.createdAt),
  ],
);
```

Confirm `boolean` is already imported from `drizzle-orm/pg-core` at the top of `schema.ts` (it
is, used by other tables) — no new import needed beyond what the file already has for
`pgTable`/`integer`/`text`/`timestamp`/`index`/`pgEnum`.

- [ ] **Step 2: Generate and apply the migration**

Run: `pnpm --filter @agentfactory/db db:generate`
Expected: a new `NNNN_<name>.sql` file appears under `packages/db/drizzle/` (drizzle-kit names
it), plus an updated `meta/_journal.json` and a new `meta/NNNN_snapshot.json` — do not hand-edit
any of these.

Run: `pnpm --filter @agentfactory/db db:migrate`
Expected: migration applies cleanly against the local dev Postgres (needs `DATABASE_URL` set,
per the repo's normal `pnpm setup:env` flow).

- [ ] **Step 3: Add `PrReview` to `@agentfactory/core`**

In `packages/core/src/domain.ts`, near `Artifact`:

```ts
export type ReviewVerdict = "comment" | "request_changes";

export interface PrReview {
  id: ID;
  orgId: ID;
  taskId: ID;
  runId: ID;
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  verdict: ReviewVerdict;
  postedAs: ReviewVerdict;
  githubReviewId: string;
  url: string;
  commentCount: number;
  truncated: boolean;
  createdAt: ISODateTime;
}
```

- [ ] **Step 4: Write the failing db-integration test**

Create `packages/db/src/__tests__/repositories/pr-reviews.test.ts`, mirroring
`run-evals.test.ts`'s structure exactly (same `import "../setup.js"`, same fixtures import):

```ts
import { describe, expect, it } from "vitest";
import "../setup.js";
import { createRun } from "../../repositories/runs.js";
import { createPrReview, getLatestPrReview, listPrReviewsForTask } from "../../repositories/pr-reviews.js";
import { insertAgent, insertOrg, insertSession, insertTask } from "../fixtures.js";

async function setupTaskAndRun() {
  const org = await insertOrg();
  const agent = await insertAgent(org.id);
  const session = await insertSession(org.id, agent.id);
  const task = await insertTask(org.id, { sessionId: session.id });
  const run = await createRun(session.id);
  return { org, task, run };
}

const INPUT = {
  repoFullName: "acme-org/platform",
  prNumber: 42,
  baseSha: "basesha1",
  headSha: "headsha1",
  verdict: "comment" as const,
  postedAs: "comment" as const,
  githubReviewId: "555",
  url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
  commentCount: 3,
  truncated: false,
};

describe("pr-reviews repository", () => {
  it("creates a review row and reads it back", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const review = await createPrReview(org.id, task.id, run.id, INPUT);

    expect(review).toMatchObject({ orgId: org.id, taskId: task.id, runId: run.id, ...INPUT });
    expect(review.createdAt).toBeDefined();
  });

  it("getLatestPrReview returns the most recently created row for the task, org-scoped", async () => {
    const { org, task, run } = await setupTaskAndRun();
    await createPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha1" });
    const second = await createPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha2" });

    await expect(getLatestPrReview(task.id, org.id)).resolves.toEqual(second);
  });

  it("getLatestPrReview returns undefined for a task with no reviews", async () => {
    const { org, task } = await setupTaskAndRun();
    await expect(getLatestPrReview(task.id, org.id)).resolves.toBeUndefined();
  });

  it("getLatestPrReview does not leak a review across orgs", async () => {
    const { task, run } = await setupTaskAndRun();
    const otherOrg = await insertOrg();
    await createPrReview(1, task.id, run.id, INPUT); // wrong org's id — see note below
    await expect(getLatestPrReview(task.id, otherOrg.id)).resolves.toBeUndefined();
  });

  it("listPrReviewsForTask returns every pass, newest first", async () => {
    const { org, task, run } = await setupTaskAndRun();
    const first = await createPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha1" });
    const second = await createPrReview(org.id, task.id, run.id, { ...INPUT, headSha: "headsha2" });

    await expect(listPrReviewsForTask(task.id, org.id)).resolves.toEqual([second, first]);
  });
});
```

Note on the cross-org test: replace `createPrReview(1, task.id, run.id, INPUT)` with whatever
this repo's actual convention is for "an id belonging to a different org" once you see
`insertOrg`'s real return shape in `fixtures.ts` — the point of the test is that a review created
under `task`/`run` (which belong to the first org) is invisible when queried with a *different*
org's id, so use `org.id` for creation and `otherOrg.id` for the query, exactly as the
`getLatestPrReview` calls above already do; drop the stray `1` once you confirm the fixture
shape.

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm --filter @agentfactory/db test:db -- pr-reviews`
Expected: FAIL — `../../repositories/pr-reviews.js` doesn't exist yet.

- [ ] **Step 6: Implement the repository**

Create `packages/db/src/repositories/pr-reviews.ts`, mirroring `run-evals.ts`:

```ts
import { and, desc, eq } from "drizzle-orm";
import type { PrReview, ReviewVerdict } from "@agentfactory/core";
import { db } from "../client";
import { prReviews } from "../schema";

function toPrReview(row: typeof prReviews.$inferSelect): PrReview {
  return {
    id: row.id,
    orgId: row.orgId,
    taskId: row.taskId,
    runId: row.runId,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    baseSha: row.baseSha,
    headSha: row.headSha,
    verdict: row.verdict,
    postedAs: row.postedAs,
    githubReviewId: row.githubReviewId,
    url: row.url,
    commentCount: row.commentCount,
    truncated: row.truncated,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreatePrReviewInput {
  repoFullName: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  verdict: ReviewVerdict;
  postedAs: ReviewVerdict;
  githubReviewId: string;
  url: string;
  commentCount: number;
  truncated: boolean;
}

export async function createPrReview(
  orgId: number,
  taskId: number,
  runId: number,
  input: CreatePrReviewInput,
): Promise<PrReview> {
  const [row] = await db
    .insert(prReviews)
    .values({ orgId, taskId, runId, ...input })
    .returning();
  return toPrReview(row);
}

// Newest first, id as tiebreak — same-millisecond inserts are routine in tests, matching
// run-evals.ts's listEvalsForRun convention.
export async function listPrReviewsForTask(taskId: number, orgId: number): Promise<PrReview[]> {
  const rows = await db
    .select()
    .from(prReviews)
    .where(and(eq(prReviews.taskId, taskId), eq(prReviews.orgId, orgId)))
    .orderBy(desc(prReviews.createdAt), desc(prReviews.id));
  return rows.map(toPrReview);
}

export async function getLatestPrReview(taskId: number, orgId: number): Promise<PrReview | undefined> {
  const [row] = await db
    .select()
    .from(prReviews)
    .where(and(eq(prReviews.taskId, taskId), eq(prReviews.orgId, orgId)))
    .orderBy(desc(prReviews.createdAt), desc(prReviews.id))
    .limit(1);
  return row ? toPrReview(row) : undefined;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @agentfactory/db test:db -- pr-reviews`
Expected: PASS

- [ ] **Step 8: Export from the package index**

Add to `packages/db/src/index.ts`, after `export * from "./repositories/run-evals";`:

```ts
export * from "./repositories/pr-reviews";
```

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm --filter @agentfactory/db typecheck && pnpm --filter @agentfactory/core typecheck`

```bash
git add packages/db packages/core/src/domain.ts
git commit -m "feat(db): add pr_reviews table and repository"
```

---

### Task 4: `apps/worker` — structured output plumbing (SDK `outputFormat`)

**Files:**
- Modify: `apps/worker/sandbox-image/run-turn.ts`
- Modify: `apps/worker/src/agent-runtime.ts`
- Test: `apps/worker/src/__tests__/agent-runtime.test.ts` (extend existing)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `runAgentTurn(params)` accepts an optional `outputSchema?: Record<string, unknown>`;
  `AgentTurnResult` gains `structuredOutput?: unknown`. Task 6 depends on this signature.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/__tests__/agent-runtime.test.ts`, using the existing `fakeSandbox`/
`baseParams` helpers already in that file:

```ts
describe("runAgentTurn — structured output", () => {
  it("passes OUTPUT_SCHEMA to the sandbox exec env when outputSchema is given", async () => {
    const execSpy = vi.fn(async function* () {
      yield { stream: "stdout" as const, data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` };
    });
    const sandbox = { ...fakeSandbox([]), exec: execSpy };
    const schema = { type: "object", properties: { summary: { type: "string" } } };

    await runAgentTurn({ ...baseParams(sandbox), outputSchema: schema });

    const [, , opts] = execSpy.mock.calls[0];
    expect(JSON.parse((opts as { env: Record<string, string> }).env.OUTPUT_SCHEMA)).toEqual(schema);
  });

  it("does not set OUTPUT_SCHEMA when outputSchema is omitted", async () => {
    const execSpy = vi.fn(async function* () {
      yield { stream: "stdout" as const, data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` };
    });
    const sandbox = { ...fakeSandbox([]), exec: execSpy };

    await runAgentTurn(baseParams(sandbox));

    const [, , opts] = execSpy.mock.calls[0];
    expect((opts as { env: Record<string, string> }).env.OUTPUT_SCHEMA).toBeUndefined();
  });

  it("returns structuredOutput when the sandbox result includes it", async () => {
    const sandbox = fakeSandbox([
      {
        stream: "stdout",
        data: `__RESULT__${JSON.stringify({
          text: "Reviewed.",
          providerSessionRef: "ref-1",
          structuredOutput: { summary: "Looks good", verdict: "comment", comments: [] },
        })}\n`,
      },
    ]);

    const result = await runAgentTurn(baseParams(sandbox));
    expect(result.structuredOutput).toEqual({ summary: "Looks good", verdict: "comment", comments: [] });
  });

  it("leaves structuredOutput undefined when the sandbox result omits it", async () => {
    const sandbox = fakeSandbox([
      { stream: "stdout", data: `__RESULT__${JSON.stringify({ text: "Hi", providerSessionRef: "ref-1" })}\n` },
    ]);

    const result = await runAgentTurn(baseParams(sandbox));
    expect(result.structuredOutput).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentfactory/worker test -- agent-runtime`
Expected: FAIL — `outputSchema` isn't a recognized param, `structuredOutput` isn't returned.

- [ ] **Step 3: Implement in `agent-runtime.ts`**

Update `AgentTurnResult`:

```ts
export interface AgentTurnResult {
  text: string;
  providerSessionRef: string;
  structuredOutput?: unknown;
}
```

Update `runAgentTurn`'s params type and body — add `outputSchema` to the destructured params and
to the `env` object:

```ts
export async function runAgentTurn(params: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
  systemPrompt: string;
  model: ModelSpec;
  userText: string;
  resumeSessionRef?: string;
  skillNames?: string[];
  outputSchema?: Record<string, unknown>;
  onEvent?: (type: string, data: Record<string, unknown>) => Promise<void>;
}): Promise<AgentTurnResult> {
  const { sandboxProvider, sandboxId, systemPrompt, model, userText, resumeSessionRef, skillNames, outputSchema, onEvent } =
    params;
  // ... unchanged ...
  const env: Record<string, string> = {
    SYSTEM_PROMPT: systemPrompt,
    USER_TEXT: userText,
    MODEL_ID: model.id,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  };
  if (resumeSessionRef) env.RESUME_SESSION_REF = resumeSessionRef;
  if (skillNames && skillNames.length > 0) env.SKILL_NAMES = skillNames.join(",");
  if (outputSchema) env.OUTPUT_SCHEMA = JSON.stringify(outputSchema);
  // ... rest of the function is unchanged; the final `JSON.parse(jsonLine) as AgentTurnResult`
  // already round-trips whatever fields run-turn.ts's RESULT_MARKER payload includes, so
  // structuredOutput needs no further handling here. ...
```

- [ ] **Step 4: Wire `outputFormat` through `run-turn.ts`**

Modify `apps/worker/sandbox-image/run-turn.ts`:

```ts
async function main(): Promise<void> {
  const systemPrompt = process.env.SYSTEM_PROMPT ?? "";
  const userText = process.env.USER_TEXT ?? "";
  const model = process.env.MODEL_ID;
  const resume = process.env.RESUME_SESSION_REF || undefined;
  const skillNamesEnv = process.env.SKILL_NAMES;
  const skills = skillNamesEnv ? skillNamesEnv.split(",").filter(Boolean) : [];
  const outputSchemaEnv = process.env.OUTPUT_SCHEMA;
  const outputFormat = outputSchemaEnv
    ? ({ type: "json_schema", schema: JSON.parse(outputSchemaEnv) } as const)
    : undefined;

  let resultText: string | undefined;
  let sessionId: string | undefined;
  let structuredOutput: unknown;

  try {
    for await (const message of query({
      prompt: userText,
      options: {
        model,
        systemPrompt,
        cwd: "/workspace",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        resume,
        skills,
        thinking: { type: "adaptive", display: "summarized" },
        ...(outputFormat ? { outputFormat } : {}),
      },
    })) {
      if (message.type === "assistant") {
        // ... unchanged ...
      } else if (message.type === "result") {
        sessionId = message.session_id;
        if (message.subtype === "success") {
          resultText = message.result;
          structuredOutput = message.structured_output;
        } else {
          throw new Error(`Claude Agent SDK run failed: ${message.subtype} (${message.errors.join(", ") || "no details"})`);
        }
      }
    }
  } catch (err) {
    // ... unchanged ...
  }

  if (resultText === undefined || sessionId === undefined) {
    throw new Error("Claude Agent SDK query completed without a result message");
  }

  process.stdout.write(
    `${RESULT_MARKER}${JSON.stringify({
      text: resultText,
      providerSessionRef: sessionId,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    })}\n`,
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @agentfactory/worker test -- agent-runtime`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: PASS (this exercises `run-turn.ts` too, since it's part of the worker package's
typecheck scope — confirm this by checking `apps/worker/tsconfig.json`'s `include`; if
`sandbox-image` is excluded from the main tsconfig, run `pnpm --filter @agentfactory/worker
typecheck` and separately confirm `run-turn.ts` has no obvious type errors by eye, since its
`sandbox-image/package.json` may have its own isolated build).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/sandbox-image/run-turn.ts apps/worker/src/agent-runtime.ts apps/worker/src/__tests__/agent-runtime.test.ts
git commit -m "feat(worker): thread the SDK's outputFormat/structured_output through runAgentTurn"
```

---

### Task 5: `apps/worker` — a review-run system prompt (no "commit and push" instructions)

**Files:**
- Modify: `apps/worker/src/prompt-composition.ts`
- Test: `apps/worker/src/__tests__/prompt-composition.test.ts` (extend existing)

**Interfaces:**
- Consumes: nothing new.
- Produces: `composeSystemPrompt` gains a leading `preamble: string` parameter (existing call
  sites must pass `PLATFORM_PREAMBLE` explicitly); new exports `REVIEW_PLATFORM_PREAMBLE` and
  `formatReviewEnvironmentForPrompt(env: ReviewEnvironment): string`.

**Why:** `PLATFORM_PREAMBLE` currently says "commit it and open a pull request rather than
pushing directly to a protected branch" — actively wrong for a review run, which must never
commit or push. `composeSystemPrompt` hardcodes this constant today; it needs to accept the
preamble as a parameter so a review run can supply a different one.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/__tests__/prompt-composition.test.ts`. First, update every existing call
to `composeSystemPrompt` in that file to pass `PLATFORM_PREAMBLE` as the new first argument (the
existing test at the top of the file, shown in the read-through above, becomes):

```ts
const { prompt } = composeSystemPrompt(
  PLATFORM_PREAMBLE,
  "## Environment\n\nCheckout is at /workspace.\n\n---\n\n",
  priorSeg("## Prior Conversation\n\nUser: what happened before?\n\n---\n\n"),
  teamSeg("## Team Context\n\nUse pnpm.\n\n---\n\n"),
  repoSeg("## Repo Map\n\nThis is a monorepo.\n\n---\n\n"),
  retrievedSeg("## Retrieved Context\n\nPage the on-call.\n\n---\n\n"),
  "You are a reviewer.",
);
```

Apply the same one-argument insertion to every other `composeSystemPrompt(...)` call in this
test file (grep the file for `composeSystemPrompt(` to find them all).

Then add new tests:

```ts
describe("REVIEW_PLATFORM_PREAMBLE", () => {
  it("never tells the agent to commit or push", () => {
    expect(REVIEW_PLATFORM_PREAMBLE.toLowerCase()).not.toMatch(/commit|push/);
  });

  it("is accepted by composeSystemPrompt as an alternative preamble", () => {
    const { prompt } = composeSystemPrompt(
      REVIEW_PLATFORM_PREAMBLE,
      "",
      priorSeg(""),
      teamSeg(""),
      repoSeg(""),
      retrievedSeg(""),
      "You are a reviewer.",
    );
    expect(prompt.startsWith(REVIEW_PLATFORM_PREAMBLE)).toBe(true);
    expect(prompt).not.toContain(PLATFORM_PREAMBLE);
  });
});

describe("formatReviewEnvironmentForPrompt", () => {
  it("states the PR number, range, and structured-output instruction", () => {
    const text = formatReviewEnvironmentForPrompt({
      workspacePath: "/workspace",
      prNumber: 42,
      focusBaseSha: "abc123",
      focusHeadSha: "def456",
      rewritten: false,
      truncatedDiff: false,
    });
    expect(text).toContain("/workspace");
    expect(text).toContain("#42");
    expect(text).toContain("abc123");
    expect(text).toContain("def456");
  });

  it("warns the agent when the branch was rewritten (force-push)", () => {
    const text = formatReviewEnvironmentForPrompt({
      workspacePath: "/workspace",
      prNumber: 42,
      focusBaseSha: "base",
      focusHeadSha: "head",
      rewritten: true,
      truncatedDiff: false,
    });
    expect(text.toLowerCase()).toMatch(/rewritten|force/);
  });

  it("tells the agent the diff was truncated and to use git diff itself", () => {
    const text = formatReviewEnvironmentForPrompt({
      workspacePath: "/workspace",
      prNumber: 42,
      focusBaseSha: "base",
      focusHeadSha: "head",
      rewritten: false,
      truncatedDiff: true,
    });
    expect(text.toLowerCase()).toContain("truncated");
    expect(text).toContain("git diff");
  });
});
```

Add the new imports to the top of the test file:

```ts
import {
  PLATFORM_PREAMBLE,
  REVIEW_PLATFORM_PREAMBLE,
  buildPriorConversationSegment,
  buildRepoMapSegment,
  buildRetrievedContextSegment,
  buildTeamContextSegment,
  composeSystemPrompt,
  formatEnvironmentForPrompt,
  formatPriorConversationForPrompt,
  formatReviewEnvironmentForPrompt,
  hashPrompt,
} from "../prompt-composition";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentfactory/worker test -- prompt-composition`
Expected: FAIL — `composeSystemPrompt`'s signature doesn't match, `REVIEW_PLATFORM_PREAMBLE`/
`formatReviewEnvironmentForPrompt` don't exist.

- [ ] **Step 3: Implement in `prompt-composition.ts`**

Add near `PLATFORM_PREAMBLE`:

```ts
// Sibling to PLATFORM_PREAMBLE for review runs — deliberately does NOT say "commit and open a
// PR": a review run never commits, pushes, or has push credentials in the sandbox at all. It
// also tells the agent up front how its answer reaches GitHub, since the agent otherwise has no
// way to know its final message is parsed as structured data rather than read as prose.
export const REVIEW_PLATFORM_PREAMBLE =
  "You are an AgentFactory agent, reviewing a GitHub pull request. You run inside a sandboxed, " +
  "read-only git checkout of the PR — you have no push credentials and should not attempt to " +
  "commit, push, or modify the repository. Read the code as thoroughly as you need to (the " +
  "full checkout is available, not just the diff). End your turn with a structured review: a " +
  "short summary, a verdict of either 'comment' or 'request_changes', and a list of inline " +
  "comments anchored to specific files and line numbers. The platform posts this as a real " +
  "GitHub review after your turn ends — you never call GitHub yourself.\n\n---\n\n";
```

Update `composeSystemPrompt`'s signature and body:

```ts
export function composeSystemPrompt(
  preamble: string,
  environment: string,
  priorConversation: PromptSegment,
  teamContext: PromptSegment,
  repoMap: PromptSegment,
  retrievedContext: PromptSegment,
  agentSystemPrompt: string,
): ComposedPrompt {
  const segments: PromptSegment[] = [
    { id: "platform_preamble", text: preamble },
    { id: "environment", text: environment },
    priorConversation,
    repoMap,
    retrievedContext,
    teamContext,
    { id: "agent_system_prompt", text: agentSystemPrompt },
  ];
  return { segments, prompt: segments.map((s) => s.text).join("") };
}
```

Add a new environment formatter, near `formatEnvironmentForPrompt`:

```ts
export interface ReviewEnvironment {
  workspacePath: string;
  prNumber: number;
  focusBaseSha: string;
  focusHeadSha: string;
  rewritten: boolean;
  truncatedDiff: boolean;
}

// The review-run equivalent of formatEnvironmentForPrompt — states what the dev-run version
// states (checkout location, "don't go looking for it"), but describes a PR range to review
// instead of a branch to work on, and never mentions committing or pushing.
export function formatReviewEnvironmentForPrompt(env: ReviewEnvironment): string {
  const lines: string[] = [
    `- Your git checkout is at \`${env.workspacePath}\`, checked out at pull request #${env.prNumber}'s ` +
      "current head. Do not search the filesystem for it.",
    `- Focus your review on the range \`${env.focusBaseSha}\`..\`${env.focusHeadSha}\`. The full PR diff ` +
      "for that range is included below.",
  ];
  if (env.rewritten) {
    lines.push(
      "- This PR's branch history was rewritten (force-pushed) since the last review, so the range " +
        "above covers the whole PR again rather than just what changed since last time — your prior " +
        "comments may no longer apply cleanly to the new history.",
    );
  }
  if (env.truncatedDiff) {
    lines.push(
      "- The diff below was truncated because this PR is very large. Use `git diff` yourself in the " +
        "checkout to see the rest before finishing your review.",
    );
  }
  return `## Environment\n\n${lines.join("\n")}\n\n---\n\n`;
}
```

- [ ] **Step 4: Update the two existing `composeSystemPrompt` call sites in `worker.ts`**

`apps/worker/src/worker.ts` currently calls `composeSystemPrompt(environment, ...)` once, for the
dev-task path. Change that call to pass `PLATFORM_PREAMBLE` first (this task only fixes the
signature at this one existing call site; Task 7 adds the review-run branch that calls it a
second way):

```ts
const composed = composeSystemPrompt(
  PLATFORM_PREAMBLE,
  environment,
  buildPriorConversationSegment(resumeIsValid, priorConversationText),
  buildTeamContextSegment(Boolean(team), teamContextPrefix),
  buildRepoMapSegment(Boolean(task?.codebase), repoMap),
  retrievedContextSegment,
  agent.systemPrompt,
);
```

Add `PLATFORM_PREAMBLE` to `worker.ts`'s existing import from `./prompt-composition`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @agentfactory/worker test -- prompt-composition`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/prompt-composition.ts apps/worker/src/__tests__/prompt-composition.test.ts apps/worker/src/worker.ts
git commit -m "feat(worker): a review-run preamble/environment that never says commit or push

composeSystemPrompt now takes the preamble as a parameter instead of
hardcoding PLATFORM_PREAMBLE, so a review run can supply
REVIEW_PLATFORM_PREAMBLE — the dev-run preamble told the agent to commit
and open a PR, which is actively wrong for a run that reviews one instead."
```

---

### Task 6: `apps/worker/src/pr-review.ts` — the pure review logic

This is the core new module: sandbox checkout of a PR ref, diff-range resolution, diff
truncation, comment validation against the real diff, and rendering the structured output as
readable transcript text. All pure/sandbox-mockable — no BullMQ, no Postgres.

**Files:**
- Create: `apps/worker/src/pr-review.ts`
- Test: `apps/worker/src/__tests__/pr-review.test.ts`

**Interfaces:**
- Consumes: `SandboxProvider`, `OutputChunk` from `./sandbox/types`; `CloneTarget`,
  `PullRequestInfo`, `ReviewComment` from `@agentfactory/scm`.
- Produces (all consumed by Task 7's `worker.ts` wiring):
  - `REVIEW_OUTPUT_SCHEMA: Record<string, unknown>`
  - `MAX_REVIEW_DIFF_CHARS: number`
  - `checkoutPullRequest(sandboxProvider, sandboxId, target, prNumber): Promise<void>`
  - `isAncestor(sandboxProvider, sandboxId, ancestorSha, descendantSha): Promise<boolean>`
  - `resolveReviewRange(params): ReviewRange`
  - `truncateDiff(diffText): { text: string; truncated: boolean }`
  - `parseDiffAnchors(diffText): Set<string>`
  - `parseStructuredReview(raw: unknown): StructuredReview` (throws on malformed shape)
  - `validateReviewComments(review, fullDiffText): ValidatedReview`
  - `renderReviewAsMarkdown(review): string`

- [ ] **Step 1: Write the failing tests for the pure functions**

Create `apps/worker/src/__tests__/pr-review.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { OutputChunk, SandboxProvider } from "../sandbox/types";
import type { CloneTarget } from "@agentfactory/scm";
import {
  MAX_REVIEW_DIFF_CHARS,
  checkoutPullRequest,
  isAncestor,
  parseDiffAnchors,
  parseStructuredReview,
  renderReviewAsMarkdown,
  resolveReviewRange,
  truncateDiff,
  validateReviewComments,
} from "../pr-review";

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

const target: CloneTarget = {
  cloneUrl: "https://x-access-token:tok@github.com/acme-org/platform.git",
  remoteUrl: "https://github.com/acme-org/platform.git",
  branch: "n/a",
  repoFullName: "acme-org/platform",
  provider: "github",
  installationRef: 999,
};

describe("checkoutPullRequest", () => {
  it("succeeds when the sandbox reports CHECKOUT_OK", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "CHECKOUT_OK\n" }]);
    await expect(checkoutPullRequest(sandbox, "sandbox-1", target, 42)).resolves.toBeUndefined();
  });

  it("throws when the sandbox reports a repo mismatch", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "REPO_MISMATCH\n" }]);
    await expect(checkoutPullRequest(sandbox, "sandbox-1", target, 42)).rejects.toThrow(/different repository/);
  });

  it("throws when the sandbox reports no success marker", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "CHECKOUT_FAILED\n" }]);
    await expect(checkoutPullRequest(sandbox, "sandbox-1", target, 42)).rejects.toThrow(/Failed to check out/);
  });
});

describe("isAncestor", () => {
  it("returns true when git reports the ancestor relationship", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "IS_ANCESTOR\n" }]);
    await expect(isAncestor(sandbox, "sandbox-1", "abc", "def")).resolves.toBe(true);
  });

  it("returns false otherwise", async () => {
    const sandbox = fakeSandbox([{ stream: "stdout", data: "NOT_ANCESTOR\n" }]);
    await expect(isAncestor(sandbox, "sandbox-1", "abc", "def")).resolves.toBe(false);
  });
});

describe("resolveReviewRange", () => {
  it("reviews the whole PR on the first pass", () => {
    expect(
      resolveReviewRange({ prBaseBranch: "main", prHeadSha: "head1", lastReviewedHeadSha: undefined, lastReviewedIsAncestorOfHead: false }),
    ).toEqual({ focusBaseSha: "main", focusHeadSha: "head1", rewritten: false });
  });

  it("reviews only what's new since the last pass when history is linear", () => {
    expect(
      resolveReviewRange({ prBaseBranch: "main", prHeadSha: "head2", lastReviewedHeadSha: "head1", lastReviewedIsAncestorOfHead: true }),
    ).toEqual({ focusBaseSha: "head1", focusHeadSha: "head2", rewritten: false });
  });

  it("falls back to the whole PR and flags rewritten when history was rewritten", () => {
    expect(
      resolveReviewRange({ prBaseBranch: "main", prHeadSha: "head2", lastReviewedHeadSha: "head1", lastReviewedIsAncestorOfHead: false }),
    ).toEqual({ focusBaseSha: "main", focusHeadSha: "head2", rewritten: true });
  });
});

describe("truncateDiff", () => {
  it("returns the diff unchanged when under the cap", () => {
    expect(truncateDiff("short diff")).toEqual({ text: "short diff", truncated: false });
  });

  it("truncates with a marker when over the cap", () => {
    const big = "x".repeat(MAX_REVIEW_DIFF_CHARS + 100);
    const { text, truncated } = truncateDiff(big);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain("truncated");
  });
});

describe("parseDiffAnchors", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " context line",
    "-old line",
    "+new line one",
    "+new line two",
  ].join("\n");

  it("includes added and context lines on the new side", () => {
    const anchors = parseDiffAnchors(diff);
    expect(anchors.has("src/a.ts:10")).toBe(true); // context line
    expect(anchors.has("src/a.ts:11")).toBe(true); // new line one
    expect(anchors.has("src/a.ts:12")).toBe(true); // new line two
  });

  it("does not anchor to a deleted line's number", () => {
    const anchors = parseDiffAnchors(diff);
    // the deleted line consumed an old-side number only; no new-side line was skipped for it
    // here, but a diff with an isolated deletion must never produce a false anchor for it
    const deletionOnly = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -5,2 +5,1 @@", " kept", "-removed"].join("\n");
    expect(parseDiffAnchors(deletionOnly).size).toBe(1); // only the context line at new-side 5
  });
});

describe("parseStructuredReview", () => {
  it("parses a well-formed payload", () => {
    const raw = { summary: "ok", verdict: "comment", comments: [{ path: "a.ts", line: 1, body: "nit" }] };
    expect(parseStructuredReview(raw)).toEqual(raw);
  });

  it("throws on a missing verdict", () => {
    expect(() => parseStructuredReview({ summary: "ok", comments: [] })).toThrow(/verdict/);
  });

  it("throws on an invalid verdict value", () => {
    expect(() => parseStructuredReview({ summary: "ok", verdict: "approve", comments: [] })).toThrow(/verdict/);
  });

  it("throws on undefined input", () => {
    expect(() => parseStructuredReview(undefined)).toThrow();
  });
});

describe("validateReviewComments", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,2 @@",
    " context",
    "+added",
  ].join("\n");

  it("keeps comments anchored to a real diff line", () => {
    const review = { summary: "s", verdict: "comment" as const, comments: [{ path: "src/a.ts", line: 11, body: "nit" }] };
    const result = validateReviewComments(review, diff);
    expect(result.comments).toEqual([{ path: "src/a.ts", line: 11, body: "nit" }]);
    expect(result.summary).toBe("s");
  });

  it("folds an invalid anchor into the summary instead of dropping it", () => {
    const review = { summary: "s", verdict: "comment" as const, comments: [{ path: "src/a.ts", line: 999, body: "nit" }] };
    const result = validateReviewComments(review, diff);
    expect(result.comments).toEqual([]);
    expect(result.summary).toContain("src/a.ts:999");
    expect(result.summary).toContain("nit");
  });
});

describe("renderReviewAsMarkdown", () => {
  it("renders the summary, verdict, and comment list as markdown", () => {
    const md = renderReviewAsMarkdown({
      summary: "Looks solid.",
      verdict: "request_changes",
      comments: [{ path: "src/a.ts", line: 11, body: "consider a null check" }],
    });
    expect(md).toContain("Looks solid.");
    expect(md.toLowerCase()).toContain("request changes");
    expect(md).toContain("src/a.ts:11");
    expect(md).toContain("consider a null check");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentfactory/worker test -- pr-review`
Expected: FAIL — `../pr-review` doesn't exist yet.

- [ ] **Step 3: Implement `apps/worker/src/pr-review.ts`**

```ts
import type { CloneTarget } from "@agentfactory/scm";
import type { SandboxProvider } from "./sandbox/types";

// Matches eval-judge.ts's MAX_ARTEFACT_CHARS — same kind of text (a diff), same codebase, one
// number to reason about rather than a second independently-chosen cap.
export const MAX_REVIEW_DIFF_CHARS = 120_000;

export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    verdict: { type: "string", enum: ["comment", "request_changes"] },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer" },
          body: { type: "string" },
        },
        required: ["path", "line", "body"],
      },
    },
  },
  required: ["summary", "verdict", "comments"],
} as const;

export interface StructuredReview {
  summary: string;
  verdict: "comment" | "request_changes";
  comments: Array<{ path: string; line: number; body: string }>;
}

// Runtime validation of the SDK's structured_output field, which is typed `unknown` — the SDK's
// own outputFormat retry loop makes a malformed shape unlikely, but worker.ts still needs to
// trust this before using it for anything, so this throws a clear error rather than casting.
export function parseStructuredReview(raw: unknown): StructuredReview {
  if (typeof raw !== "object" || raw === null) throw new Error("Structured review output is not an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== "string") throw new Error("Structured review output is missing 'summary'");
  if (obj.verdict !== "comment" && obj.verdict !== "request_changes") {
    throw new Error(`Structured review output has an invalid 'verdict': ${JSON.stringify(obj.verdict)}`);
  }
  if (!Array.isArray(obj.comments)) throw new Error("Structured review output is missing 'comments'");
  const comments = obj.comments.map((c, i) => {
    if (typeof c !== "object" || c === null) throw new Error(`comments[${i}] is not an object`);
    const co = c as Record<string, unknown>;
    if (typeof co.path !== "string") throw new Error(`comments[${i}].path is not a string`);
    if (typeof co.line !== "number") throw new Error(`comments[${i}].line is not a number`);
    if (typeof co.body !== "string") throw new Error(`comments[${i}].body is not a string`);
    return { path: co.path, line: co.line, body: co.body };
  });
  return { summary: obj.summary, verdict: obj.verdict, comments };
}

// Truncates diff text for the prompt only — never for validation, which always uses the full
// diff (see validateReviewComments). The agent is told in its environment segment when this
// happened and pointed at `git diff` for the rest.
export function truncateDiff(diffText: string): { text: string; truncated: boolean } {
  if (diffText.length <= MAX_REVIEW_DIFF_CHARS) return { text: diffText, truncated: false };
  return { text: `${diffText.slice(0, MAX_REVIEW_DIFF_CHARS)}\n…[diff truncated]`, truncated: true };
}

// Every "path:line" position on the NEW side of a unified diff that a GitHub inline comment can
// legally anchor to — added ('+') and context (' ') lines, per a hunk header's new-file range.
// Deleted ('-') lines never advance the new-side counter and are never valid anchors (v1 does
// not support commenting on deleted lines — see the design spec).
export function parseDiffAnchors(diffText: string): Set<string> {
  const anchors = new Set<string>();
  let currentPath: string | undefined;
  let newLine = 0;
  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const fileHeaderRe = /^\+\+\+ b\/(.+)$/;

  for (const line of diffText.split("\n")) {
    const fileMatch = fileHeaderRe.exec(line);
    if (fileMatch) {
      currentPath = fileMatch[1];
      continue;
    }
    const hunkMatch = hunkHeaderRe.exec(line);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }
    if (!currentPath) continue;
    if (line.startsWith("+")) {
      anchors.add(`${currentPath}:${newLine}`);
      newLine++;
    } else if (line.startsWith(" ")) {
      anchors.add(`${currentPath}:${newLine}`);
      newLine++;
    }
    // '-' lines: do not advance newLine, never anchor.
  }
  return anchors;
}

export interface ValidatedComment {
  path: string;
  line: number;
  body: string;
}

export interface ValidatedReview {
  summary: string;
  verdict: "comment" | "request_changes";
  comments: ValidatedComment[];
}

// Splits the agent's comments into those that land on a real diff line (kept as-is) and those
// that don't (folded into the summary as "path:line — body" rather than silently dropped —
// nothing the agent said is lost, it just can't be anchored on GitHub). `fullDiffText` must be
// the PR's whole base→head diff, not just the range the agent was asked to focus on: GitHub
// anchors comments against the full diff at head, so a remark about a line changed in an
// earlier pass is still a valid anchor.
export function validateReviewComments(review: StructuredReview, fullDiffText: string): ValidatedReview {
  const anchors = parseDiffAnchors(fullDiffText);
  const comments: ValidatedComment[] = [];
  const invalid: string[] = [];

  for (const c of review.comments) {
    if (anchors.has(`${c.path}:${c.line}`)) {
      comments.push(c);
    } else {
      invalid.push(`${c.path}:${c.line} — ${c.body}`);
    }
  }

  const summary = invalid.length > 0 ? `${review.summary}\n\n${invalid.join("\n")}` : review.summary;
  return { summary, verdict: review.verdict, comments };
}

export function renderReviewAsMarkdown(review: ValidatedReview): string {
  const verdictLabel = review.verdict === "request_changes" ? "Request changes" : "Comment";
  const lines = [`**Verdict: ${verdictLabel}**`, "", review.summary];
  if (review.comments.length > 0) {
    lines.push("", "**Inline comments:**");
    for (const c of review.comments) {
      lines.push(`- \`${c.path}:${c.line}\` — ${c.body}`);
    }
  }
  return lines.join("\n");
}

export interface ReviewRange {
  focusBaseSha: string;
  focusHeadSha: string;
  rewritten: boolean;
}

// Decides what to tell the agent to focus on. Validation (validateReviewComments) always uses
// the full PR diff regardless of what this returns — this only narrows the agent's *prompt*.
export function resolveReviewRange(params: {
  prBaseBranch: string;
  prHeadSha: string;
  lastReviewedHeadSha?: string;
  lastReviewedIsAncestorOfHead: boolean;
}): ReviewRange {
  const { prBaseBranch, prHeadSha, lastReviewedHeadSha, lastReviewedIsAncestorOfHead } = params;
  if (!lastReviewedHeadSha) {
    return { focusBaseSha: prBaseBranch, focusHeadSha: prHeadSha, rewritten: false };
  }
  if (!lastReviewedIsAncestorOfHead) {
    return { focusBaseSha: prBaseBranch, focusHeadSha: prHeadSha, rewritten: true };
  }
  return { focusBaseSha: lastReviewedHeadSha, focusHeadSha: prHeadSha, rewritten: false };
}

// Checks out a PR's current head into a local `review/pr-N` branch, force-checked-out on every
// call so a warm sandbox always lands on the current head and discards whatever a prior pass's
// exploration left behind. Clones into /workspace first if it isn't already a git checkout —
// mirrors cloneIntoSandbox's REPO_MISMATCH guard (apps/worker/src/scm-provider.ts) but never
// creates an agent/session-* branch, since a review run never commits or pushes. Fetches
// GitHub's `refs/pull/N/head`, which works identically for same-repo and fork PRs — there is no
// separate "is this a fork" branch in this logic. target.cloneUrl already carries a token minted
// this run (by resolveCloneTarget); it's used for the fetch and the remote is reset to
// target.remoteUrl (credential-free) immediately after, unconditionally, mirroring
// pushChangesIfDirty's inject-use-strip pattern.
export async function checkoutPullRequest(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  target: CloneTarget,
  prNumber: number,
): Promise<void> {
  const script = `
if [ -d /workspace/.git ]; then
  CURRENT_REMOTE=$(git -C /workspace remote get-url origin 2>/dev/null)
  case "$CURRENT_REMOTE" in
    *"$REPO_FULL_NAME.git") : ;;
    *) echo REPO_MISMATCH; exit 0 ;;
  esac
else
  git clone --no-checkout "$CLONE_URL" /workspace
  if [ $? -ne 0 ]; then echo CHECKOUT_FAILED; exit 0; fi
  git -C /workspace remote set-url origin "$REMOTE_URL"
fi
cd /workspace || { echo CHECKOUT_FAILED; exit 0; }
git remote set-url origin "$CLONE_URL"
git fetch origin "pull/$PR_NUMBER/head:review/pr-$PR_NUMBER" --force --quiet
FETCH_STATUS=$?
git remote set-url origin "$REMOTE_URL"
if [ "$FETCH_STATUS" -ne 0 ]; then echo CHECKOUT_FAILED; exit 0; fi
git checkout -f "review/pr-$PR_NUMBER"
if [ $? -ne 0 ]; then echo CHECKOUT_FAILED; exit 0; fi
echo CHECKOUT_OK`;

  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: {
      CLONE_URL: target.cloneUrl,
      REMOTE_URL: target.remoteUrl,
      REPO_FULL_NAME: target.repoFullName,
      PR_NUMBER: String(prNumber),
    },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }

  if (stdout.includes("REPO_MISMATCH")) {
    throw new Error(`Sandbox workspace already contains a different repository than "${target.repoFullName}"`);
  }
  if (!stdout.includes("CHECKOUT_OK")) {
    throw new Error(`Failed to check out pull request #${prNumber} into sandbox workspace`);
  }
}

// Whether `ancestorSha` is an ancestor of `descendantSha` on the checked-out repo — decides
// whether a re-review's range can be incremental (resolveReviewRange) or must fall back to the
// whole PR after a force-push.
export async function isAncestor(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  ancestorSha: string,
  descendantSha: string,
): Promise<boolean> {
  const script = `
cd /workspace || { echo NOT_ANCESTOR; exit 0; }
if git merge-base --is-ancestor "$ANCESTOR_SHA" "$DESCENDANT_SHA" 2>/dev/null; then
  echo IS_ANCESTOR
else
  echo NOT_ANCESTOR
fi`;
  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, ["sh", "-c", script], {
    env: { ANCESTOR_SHA: ancestorSha, DESCENDANT_SHA: descendantSha },
  })) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }
  return stdout.includes("IS_ANCESTOR");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @agentfactory/worker test -- pr-review`
Expected: PASS. If `parseDiffAnchors`'s hunk-header line-counting test doesn't match your mental
model of unified-diff line numbering, work through the `parseDiffAnchors` test's expected values
by hand against the sample diff before changing the implementation — the counting rule is: every
line in a hunk that is NOT a deletion (`-`) consumes one new-side line number, starting from the
hunk header's `+start`.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentfactory/worker typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/pr-review.ts apps/worker/src/__tests__/pr-review.test.ts
git commit -m "feat(worker): PR-review sandbox checkout, range resolution, diff validation

Pure/sandbox-mockable module: checkoutPullRequest fetches refs/pull/N/head
into the sandbox (works for forks too, never creates a dev branch),
resolveReviewRange decides incremental vs full-PR (falling back on a
detected force-push), validateReviewComments anchors the agent's structured
output against the PR's real diff (folding unanchorable comments into the
summary instead of dropping them), and truncateDiff caps what's shown to
the agent at MAX_REVIEW_DIFF_CHARS (matches eval-judge.ts's existing cap)."
```

---

### Task 7: `apps/worker/src/worker.ts` — wire the review branch into the run pipeline

**Files:**
- Modify: `apps/worker/src/worker.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 4, 5, 6.
- Produces: no new exports — this is the orchestration task. No direct unit test (matches this
  file's existing convention: `worker.ts` itself has no `worker.test.ts`, since its job is wiring
  together already-tested pieces behind BullMQ/Docker). Verified manually in Step 3.

- [ ] **Step 1: Add the new imports**

Add to `apps/worker/src/worker.ts`'s existing import block:

```ts
import {
  getScmProvider,
  parsePullRequestReferenceAcrossProviders,
  resolveScmConnection,
} from "@agentfactory/scm";
import { createPrReview, getLatestPrReview } from "@agentfactory/db";
import {
  MAX_REVIEW_DIFF_CHARS,
  REVIEW_OUTPUT_SCHEMA,
  checkoutPullRequest,
  isAncestor,
  parseStructuredReview,
  renderReviewAsMarkdown,
  resolveReviewRange,
  truncateDiff,
  validateReviewComments,
} from "./pr-review";
import {
  REVIEW_PLATFORM_PREAMBLE,
  formatReviewEnvironmentForPrompt,
} from "./prompt-composition"; // merge into the existing prompt-composition import block
```

- [ ] **Step 2: Branch the workspace-resolution block on a parsed PR reference**

In the run handler, find the existing block:

```ts
      const task = await getTaskBySessionId(session.id);
      let workspace: CloneTarget | undefined;
      let repoMap = "";
      let taskDocuments: MaterialisedTaskDocuments = { written: [], omitted: [] };
      let skillNames: string[] = [];
      let repoSync: SandboxEnvironment["repoSync"];
      if (task?.codebase) {
        workspace = await resolveCloneTarget(agent.orgId, task.codebase, `agent/session-${session.id}`);
        // ... existing dev-task clone/sync/task-documents/skills/repo-map body ...
      }
```

Replace it with a version that checks for a PR reference first. The dev-task body inside the
existing `if (task?.codebase)` is UNCHANGED — only wrap it in an `else if`, and add the new
`if` branch above it:

```ts
      const task = await getTaskBySessionId(session.id);
      let workspace: CloneTarget | undefined;
      let repoMap = "";
      let taskDocuments: MaterialisedTaskDocuments = { written: [], omitted: [] };
      let skillNames: string[] = [];
      let repoSync: SandboxEnvironment["repoSync"];

      // Set only on the review path — carries everything the post-turn block (Step 4 below)
      // needs to validate and post the review, and everything the prompt-composition branch
      // (Step 3 below) needs to build the review environment segment.
      let review:
        | {
            prNumber: number;
            repoFullName: string;
            focusBaseSha: string;
            focusHeadSha: string;
            fullDiffText: string;
            focusDiffText: string;
            diffTruncated: boolean;
            rewritten: boolean;
            existingComments: string;
          }
        | undefined;

      const prRef = parsePullRequestReferenceAcrossProviders(task?.description ?? "");
      if (prRef) {
        const resolved = await resolveScmConnection(agent.orgId, prRef.repoFullName);
        if (!resolved) {
          throw new Error(
            `PR ${prRef.repoFullName}#${prRef.prNumber} isn't accessible via any connected GitHub installation`,
          );
        }
        const { connection, provider } = resolved;
        const pr = await provider.fetchPullRequest(connection, prRef.repoFullName, prRef.prNumber);
        if (pr.state !== "open") {
          throw new Error(`PR ${prRef.repoFullName}#${prRef.prNumber} is already ${pr.state} — nothing to review`);
        }

        workspace = await provider.resolveCloneTarget(connection, prRef.repoFullName, "pull-request-review");
        await checkoutPullRequest(sandboxProvider, sandboxId, workspace, prRef.prNumber);
        mark("PR checkout");

        const lastReview = await getLatestPrReview(task!.id, agent.orgId);
        const lastReviewedHeadSha = lastReview?.headSha;
        const lastReviewedIsAncestorOfHead = lastReviewedHeadSha
          ? await isAncestor(sandboxProvider, sandboxId, lastReviewedHeadSha, pr.headSha)
          : false;
        const range = resolveReviewRange({
          prBaseBranch: pr.baseBranch,
          prHeadSha: pr.headSha,
          lastReviewedHeadSha,
          lastReviewedIsAncestorOfHead,
        });

        const fullDiffText = await provider.fetchCommitRangeDiff(workspace, {
          baseSha: pr.baseBranch,
          headSha: pr.headSha,
        });
        const focusDiffTextRaw =
          range.focusBaseSha === pr.baseBranch
            ? fullDiffText
            : await provider.fetchCommitRangeDiff(workspace, { baseSha: range.focusBaseSha, headSha: range.focusHeadSha });
        const { text: focusDiffText, truncated: diffTruncated } = truncateDiff(focusDiffTextRaw);

        const existingThreads = lastReviewedHeadSha ? await provider.fetchReviewThreads(connection, prRef.repoFullName, prRef.prNumber) : [];
        const existingComments =
          existingThreads.length > 0
            ? `## Existing Review Comments\n\n${existingThreads
                .map((c) => `- ${c.path}:${c.line ?? "?"} (${c.author}): ${c.body}`)
                .join("\n")}\n\n---\n\n`
            : "";

        review = {
          prNumber: prRef.prNumber,
          repoFullName: prRef.repoFullName,
          focusBaseSha: range.focusBaseSha,
          focusHeadSha: range.focusHeadSha,
          fullDiffText,
          focusDiffText,
          diffTruncated,
          rewritten: range.rewritten,
          existingComments,
        };
        mark("PR diff fetched");
      } else if (task?.codebase) {
        workspace = await resolveCloneTarget(agent.orgId, task.codebase, `agent/session-${session.id}`);
        // ... existing dev-task clone/sync/task-documents/skills/repo-map body, unchanged ...
      }
```

- [ ] **Step 3: Branch prompt composition on `review`**

Find the existing prompt-composition block (the one updated in Task 5, Step 4). Wrap it: when
`review` is set, compose a review prompt instead of the dev-task prompt. Insert this just before
that block:

```ts
      let systemPrompt: string;
      let composed: ReturnType<typeof composeSystemPrompt>;
      if (review) {
        const reviewEnvironment = formatReviewEnvironmentForPrompt({
          workspacePath: "/workspace",
          prNumber: review.prNumber,
          focusBaseSha: review.focusBaseSha,
          focusHeadSha: review.focusHeadSha,
          rewritten: review.rewritten,
          truncatedDiff: review.diffTruncated,
        });
        composed = composeSystemPrompt(
          REVIEW_PLATFORM_PREAMBLE,
          reviewEnvironment,
          buildPriorConversationSegment(resumeIsValid, priorConversationText),
          buildTeamContextSegment(false, ""),
          buildRepoMapSegment(false, ""),
          { id: "retrieved_context", text: "", omittedReason: "no_context_sources" },
          `${agent.systemPrompt}\n\n${review.existingComments}## PR Diff (${review.focusBaseSha}..${review.focusHeadSha})\n\n${review.focusDiffText}`,
        );
      } else {
        composed = composeSystemPrompt(
          PLATFORM_PREAMBLE,
          environment,
          buildPriorConversationSegment(resumeIsValid, priorConversationText),
          buildTeamContextSegment(Boolean(team), teamContextPrefix),
          buildRepoMapSegment(Boolean(task?.codebase), repoMap),
          retrievedContextSegment,
          agent.systemPrompt,
        );
      }
      systemPrompt = composed.prompt;
```

Remove the now-duplicate `const composed = composeSystemPrompt(...)` / `const systemPrompt =
composed.prompt;` pair that Task 5 Step 4 left in place — this block replaces it (the rest of the
existing code below, which reads `composed.segments` and `systemPrompt`, needs no further
change).

Note: `team`/`teamContextPrefix`/`retrieved`/`environment`/`repoMap` are still computed exactly
as before earlier in the function for the dev-task path — leave that code as-is; for a review run
those values simply go unused by the branch above, which is fine (a review run has no team
context or repo map by design — see the spec's "What this does not change" section, and this
also sidesteps the cross-org team-leak guard, which doesn't apply to a review with no team at
all).

- [ ] **Step 4: Pass `outputSchema` to `runAgentTurn`, and use `structuredOutput` when present**

Find:

```ts
          turnResult = await runAgentTurn({
            sandboxProvider,
            sandboxId,
            systemPrompt,
            model: attemptModel,
            userText: (triggeringMessage?.content ?? "") + issueContext,
            resumeSessionRef,
            skillNames,
            onEvent: async (type, data) => {
              await createEvent(runId, seq++, type, data);
            },
          });
```

Add `outputSchema`:

```ts
          turnResult = await runAgentTurn({
            sandboxProvider,
            sandboxId,
            systemPrompt,
            model: attemptModel,
            userText: (triggeringMessage?.content ?? "") + issueContext,
            resumeSessionRef,
            skillNames,
            outputSchema: review ? REVIEW_OUTPUT_SCHEMA : undefined,
            onEvent: async (type, data) => {
              await createEvent(runId, seq++, type, data);
            },
          });
```

- [ ] **Step 5: Replace the stored assistant message for a review run**

Find:

```ts
      const { text, providerSessionRef } = turnResult;
      mark("agent turn");

      await createMessage(run.sessionId, "assistant", text, runId);
      await createEvent(runId, seq++, "text_delta", { text });
      await createEvent(runId, seq++, "done", { reason: "completed" });

      await updateRunStatus(runId, "finalizing");
```

Insert the review post-processing between `mark("agent turn")` and the existing message/event
writes — the assistant message a review run stores is the rendered markdown, not the raw text:

```ts
      const { text, providerSessionRef } = turnResult;
      mark("agent turn");

      let transcriptText = text;
      if (review) {
        const structured = parseStructuredReview(turnResult.structuredOutput);
        const validated = validateReviewComments(structured, review.fullDiffText);
        transcriptText = renderReviewAsMarkdown(validated);

        const hasNewContent = validated.comments.length > 0 || review.focusBaseSha !== review.focusHeadSha;
        if (validated.comments.length > 0 || review.focusBaseSha === review.focusHeadSha ? false : true) {
          // placeholder removed below — see the real condition in the next block
        }

        const resolvedForPost = await resolveScmConnection(agent.orgId, review.repoFullName);
        const shouldPost = validated.comments.length > 0 || resolvedForPost !== undefined;
        // Only skip posting when there is truly nothing new: no validated comments AND this pass
        // covered zero new commits (focus range was empty because head hadn't moved since the
        // last review). A non-empty range always posts, even with zero comments, because the
        // agent may still have written a meaningful summary about genuinely new commits.
        const rangeWasEmpty = review.focusBaseSha === review.focusHeadSha;
        if (!(validated.comments.length === 0 && rangeWasEmpty)) {
          if (!resolvedForPost) {
            throw new Error(`No connected GitHub provider can post the review for ${review.repoFullName}`);
          }
          const posted = await resolvedForPost.provider.postReview(
            resolvedForPost.connection,
            review.repoFullName,
            review.prNumber,
            { summary: validated.summary, verdict: validated.verdict, comments: validated.comments },
          );
          await createPrReview(agent.orgId, task!.id, runId, {
            repoFullName: review.repoFullName,
            prNumber: review.prNumber,
            baseSha: review.focusBaseSha === review.focusHeadSha ? review.focusBaseSha : review.focusBaseSha,
            headSha: review.focusHeadSha,
            verdict: validated.verdict,
            postedAs: posted.postedAs,
            githubReviewId: posted.id,
            url: posted.url,
            commentCount: validated.comments.length,
            truncated: review.diffTruncated,
          });
          await createEvent(runId, seq++, "artifact", { artifactType: "review", label: "PR review", url: posted.url });
        }
        mark("review posted");
      }

      await createMessage(run.sessionId, "assistant", transcriptText, runId);
      await createEvent(runId, seq++, "text_delta", { text: transcriptText });
      await createEvent(runId, seq++, "done", { reason: "completed" });

      await updateRunStatus(runId, "finalizing");
```

Clean up the stray placeholder lines (`hasNewContent`, the empty `if` block, and the unused
`shouldPost` variable) that crept into the draft above — the real logic is just the
`rangeWasEmpty` check immediately after. The block should read:

```ts
      let transcriptText = text;
      if (review) {
        const structured = parseStructuredReview(turnResult.structuredOutput);
        const validated = validateReviewComments(structured, review.fullDiffText);
        transcriptText = renderReviewAsMarkdown(validated);

        // Skip posting only when there is truly nothing new: no validated comments AND this pass
        // covered zero new commits (the focus range was empty because head hadn't moved since
        // the last review). This is what stops a content-free re-run from posting a duplicate
        // summary to GitHub — see the design spec's step 7.
        const rangeWasEmpty = review.focusBaseSha === review.focusHeadSha;
        if (!(validated.comments.length === 0 && rangeWasEmpty)) {
          const resolvedForPost = await resolveScmConnection(agent.orgId, review.repoFullName);
          if (!resolvedForPost) {
            throw new Error(`No connected GitHub provider can post the review for ${review.repoFullName}`);
          }
          const posted = await resolvedForPost.provider.postReview(
            resolvedForPost.connection,
            review.repoFullName,
            review.prNumber,
            { summary: validated.summary, verdict: validated.verdict, comments: validated.comments },
          );
          await createPrReview(agent.orgId, task!.id, runId, {
            repoFullName: review.repoFullName,
            prNumber: review.prNumber,
            baseSha: review.focusBaseSha,
            headSha: review.focusHeadSha,
            verdict: validated.verdict,
            postedAs: posted.postedAs,
            githubReviewId: posted.id,
            url: posted.url,
            commentCount: validated.comments.length,
            truncated: review.diffTruncated,
          });
          await createEvent(runId, seq++, "artifact", { artifactType: "review", label: "PR review", url: posted.url });
        }
        mark("review posted");
      }

      await createMessage(run.sessionId, "assistant", transcriptText, runId);
      await createEvent(runId, seq++, "text_delta", { text: transcriptText });
      await createEvent(runId, seq++, "done", { reason: "completed" });

      await updateRunStatus(runId, "finalizing");
```

- [ ] **Step 6: Skip the dev-task push/PR-opening block for a review run, and mark the task done**

Find:

```ts
      let changedFiles: string[] = [];
      if (workspace && task) {
        const result = await pushChangesIfDirty(
          // ... existing dev-task push/open-PR body ...
      }
```

Guard it so a review run (which has `workspace` set, from Step 2, but must never push) skips it,
and add the task-completion update for the review path right after:

```ts
      let changedFiles: string[] = [];
      if (workspace && task && !review) {
        const result = await pushChangesIfDirty(
          // ... existing dev-task push/open-PR body, unchanged ...
      }

      if (review) {
        await updateTask(task!.id, { status: "done" });
      }
```

- [ ] **Step 7: Verify manually**

There is no direct `worker.test.ts` in this codebase (confirmed absent — the file's job is
orchestrating already-unit-tested pieces behind Docker/BullMQ, matching the existing pattern for
`scm-provider.ts`'s `cloneIntoSandbox`/`pushChangesIfDirty`, which are exercised only indirectly).
Verify this task's wiring by running the full worker unit suite (which covers every piece this
step composes) and a manual smoke test:

Run: `pnpm --filter @agentfactory/worker test`
Expected: PASS (all prior tasks' suites, unaffected by this orchestration-only change)

Run: `pnpm typecheck`
Expected: PASS across the whole workspace

Manual smoke test (needs a real GitHub App + installation configured per `docs/setup/github-
app.md`, and a real open PR on a connected repo):
1. `pnpm dev:all`
2. Create a task whose description is just a PR URL, e.g. `https://github.com/<org>/<repo>/pull/<n>`.
3. Assign it to any agent, click Run.
4. Confirm in the worker log that phase markers show "PR checkout" and "PR diff fetched" rather
   than "clone"/"repo sync".
5. Confirm a real review appears on the PR on GitHub, and the task's status becomes `done`.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/worker.ts
git commit -m "feat(worker): review runs check out the PR, post a GitHub review, skip the push/PR-open path

Branches worker.ts's run pipeline on parsePullRequestReferenceAcrossProviders(task.description):
checks out the PR head instead of a dev branch, composes a review-specific
prompt with REVIEW_PLATFORM_PREAMBLE, requests structured output, validates
and posts the review via ScmProvider.postReview, records a pr_reviews row,
and marks the task done — never reaching the push/open-PR block."
```

---

### Task 8: `apps/web` — API route + i18n for the task-page Review block

**Files:**
- Create: `apps/web/src/app/api/tasks/[taskId]/pr-reviews/route.ts`
- Test: `apps/web/src/app/api/tasks/[taskId]/pr-reviews/__tests__/route.test.ts`
- Modify: `apps/web/src/lib/i18n/dictionaries/en.ts`

**Interfaces:**
- Consumes: `getTask`, `getAgent`, `listPrReviewsForTask` from `@agentfactory/db`.
- Produces: `GET /api/tasks/[taskId]/pr-reviews` → `PrReview[]`, newest first. Consumed by Task 9.

- [ ] **Step 1: Write the failing route test**

Follow the existing sibling route test pattern (see
`apps/web/src/app/api/tasks/[taskId]/context-items/__tests__/route.test.ts` for the org-scoping
mock style used across this directory). Create
`apps/web/src/app/api/tasks/[taskId]/pr-reviews/__tests__/route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
vi.mock("@/server/auth", () => ({ requireAuthContext: () => requireAuthContextMock() }));

const getTaskMock = vi.fn();
const listPrReviewsForTaskMock = vi.fn();
vi.mock("@agentfactory/db", () => ({
  getTask: (id: number) => getTaskMock(id),
  listPrReviewsForTask: (taskId: number, orgId: number) => listPrReviewsForTaskMock(taskId, orgId),
}));

const { GET } = await import("../route");

function fakeReview(id: number) {
  return {
    id,
    orgId: 1,
    taskId: 7,
    runId: 100,
    repoFullName: "acme-org/platform",
    prNumber: 42,
    baseSha: "base",
    headSha: "head",
    verdict: "comment" as const,
    postedAs: "comment" as const,
    githubReviewId: "555",
    url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
    commentCount: 2,
    truncated: false,
    createdAt: new Date().toISOString(),
  };
}

describe("GET /api/tasks/[taskId]/pr-reviews", () => {
  it("returns 401 when not authenticated", async () => {
    requireAuthContextMock.mockResolvedValue(undefined);
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the task doesn't exist or belongs to another org", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue(undefined);
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(404);
  });

  it("returns the task's reviews newest first", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue({ id: 7, orgId: 1 });
    listPrReviewsForTaskMock.mockResolvedValue([fakeReview(2), fakeReview(1)]);

    const res = await GET(new Request("http://x"), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(listPrReviewsForTaskMock).toHaveBeenCalledWith(7, 1);
  });

  it("returns 404 when the task belongs to a different org", async () => {
    requireAuthContextMock.mockResolvedValue({ orgId: 1, user: { id: 1 } });
    getTaskMock.mockResolvedValue({ id: 7, orgId: 2 });
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ taskId: "7" }) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentfactory/web test -- pr-reviews`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Implement the route**

Create `apps/web/src/app/api/tasks/[taskId]/pr-reviews/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getTask, listPrReviewsForTask } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task || task.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json(await listPrReviewsForTask(task.id, ctx.orgId));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agentfactory/web test -- pr-reviews`
Expected: PASS

- [ ] **Step 5: Add i18n strings**

Add to the `taskDetail` object in `apps/web/src/lib/i18n/dictionaries/en.ts` (alongside the
existing `evalErrorGeneric`/`contextLayerTeamContext`-style entries):

```ts
    reviewSectionTitle: "Review",
    reviewVerdictComment: "Comment",
    reviewVerdictRequestChanges: "Changes requested",
    reviewPostedAsCommentFallback: "posted as a comment — PR opened by this app",
    reviewCommentCount: "{count} inline comments",
    reviewViewOnGithub: "View on GitHub",
    reviewTruncatedNotice: "This PR is very large — review coverage may be partial.",
```

(Follow whatever interpolation convention `{count}`-style strings already use elsewhere in this
file — grep `en.ts` for an existing `{count}` or similar placeholder and match its exact syntax;
the `TranslationKey` type updates automatically from this file per `paths.ts`.)

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @agentfactory/web typecheck`

```bash
git add apps/web/src/app/api/tasks/[taskId]/pr-reviews apps/web/src/lib/i18n/dictionaries/en.ts
git commit -m "feat(web): add GET /api/tasks/[taskId]/pr-reviews and its i18n strings"
```

---

### Task 9: `apps/web` — the task-page Review block

**Files:**
- Create: `apps/web/src/components/PrReviewPanel.tsx`
- Test: `apps/web/src/components/__tests__/PrReviewPanel.test.tsx`
- Modify: `apps/web/src/app/(app)/tasks/[taskId]/page.tsx`

**Interfaces:**
- Consumes: `GET /api/tasks/[taskId]/pr-reviews` (Task 8) via `apiFetch`; `PrReview` from
  `@agentfactory/core`.
- Produces: `<PrReviewPanel taskId={...} />`, rendered on the task detail page.

- [ ] **Step 1: Write the failing component test**

Follow `RunEvalPanel.test.tsx`'s mocking style for `apiFetch`. Create
`apps/web/src/components/__tests__/PrReviewPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PrReview } from "@agentfactory/core";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const { PrReviewPanel } = await import("../PrReviewPanel");

function fakeReview(overrides: Partial<PrReview> = {}): PrReview {
  return {
    id: 1,
    orgId: 1,
    taskId: 7,
    runId: 100,
    repoFullName: "acme-org/platform",
    prNumber: 42,
    baseSha: "base",
    headSha: "head",
    verdict: "comment",
    postedAs: "comment",
    githubReviewId: "555",
    url: "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
    commentCount: 3,
    truncated: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PrReviewPanel", () => {
  it("renders nothing when there are no reviews", async () => {
    apiFetchMock.mockResolvedValue([]);
    const { container } = render(<PrReviewPanel taskId={7} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows the latest review's verdict, comment count, and GitHub link", async () => {
    apiFetchMock.mockResolvedValue([fakeReview()]);
    render(<PrReviewPanel taskId={7} />);
    expect(await screen.findByText(/Comment/)).toBeInTheDocument();
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View on GitHub/i })).toHaveAttribute(
      "href",
      "https://github.com/acme-org/platform/pull/42#pullrequestreview-555",
    );
  });

  it("shows the fallback note when postedAs differs from verdict", async () => {
    apiFetchMock.mockResolvedValue([fakeReview({ verdict: "request_changes", postedAs: "comment" })]);
    render(<PrReviewPanel taskId={7} />);
    expect(await screen.findByText(/posted as a comment/i)).toBeInTheDocument();
  });

  it("shows the large-diff caveat when truncated", async () => {
    apiFetchMock.mockResolvedValue([fakeReview({ truncated: true })]);
    render(<PrReviewPanel taskId={7} />);
    expect(await screen.findByText(/very large/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentfactory/web test -- PrReviewPanel`
Expected: FAIL — the component doesn't exist yet.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/PrReviewPanel.tsx`, following `RunEvalPanel.tsx`'s structure
(client component, `apiFetch` on mount, no polling needed — a review posts once per run, and the
task page's own run-status poll is what tells the user a new run finished, at which point this
component's parent should remount/refetch it):

```tsx
"use client";

import { useEffect, useState } from "react";
import type { PrReview } from "@agentfactory/core";
import { apiFetch } from "@/lib/api-client";
import { useTranslation } from "@/lib/i18n/context";

export function PrReviewPanel({ taskId }: { taskId: number }) {
  const { t } = useTranslation();
  const [reviews, setReviews] = useState<PrReview[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PrReview[]>(`/api/tasks/${taskId}/pr-reviews`).then((data) => {
      if (!cancelled) setReviews(data);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (reviews.length === 0) return null;
  const latest = reviews[0];

  return (
    <section>
      <h3>{t("taskDetail.reviewSectionTitle")}</h3>
      <p>
        {latest.verdict === "request_changes"
          ? t("taskDetail.reviewVerdictRequestChanges")
          : t("taskDetail.reviewVerdictComment")}
        {latest.postedAs !== latest.verdict && ` (${t("taskDetail.reviewPostedAsCommentFallback")})`}
      </p>
      <p>{t("taskDetail.reviewCommentCount").replace("{count}", String(latest.commentCount))}</p>
      <a href={latest.url} target="_blank" rel="noreferrer">
        {t("taskDetail.reviewViewOnGithub")}
      </a>
      {latest.truncated && <p>{t("taskDetail.reviewTruncatedNotice")}</p>}
    </section>
  );
}
```

(Adjust the `{count}` replacement to match whatever interpolation helper the codebase already
uses elsewhere in `t()` calls, if `useTranslation` exposes one — check `@/lib/i18n/context`'s
`t` signature before assuming a plain `.replace` is the convention; use the established one if
different.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agentfactory/web test -- PrReviewPanel`
Expected: PASS

- [ ] **Step 5: Mount it on the task detail page**

In `apps/web/src/app/(app)/tasks/[taskId]/page.tsx`, add the import:

```ts
import { PrReviewPanel } from "@/components/PrReviewPanel";
```

Render `<PrReviewPanel taskId={Number(taskId)} />` near where `RunEvalPanel`/`RunContextPanel`
are already rendered for the task's runs (find that JSX block and place it alongside, so the
Review block appears in the same area of the page as the other per-run panels).

- [ ] **Step 6: Typecheck, run the full web test suite, and commit**

Run: `pnpm --filter @agentfactory/web typecheck && pnpm --filter @agentfactory/web test`
Expected: PASS

```bash
git add apps/web/src/components/PrReviewPanel.tsx apps/web/src/components/__tests__/PrReviewPanel.test.tsx "apps/web/src/app/(app)/tasks/[taskId]/page.tsx"
git commit -m "feat(web): show the posted PR review on the task detail page"
```

---

### Task 10: Full-workspace verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Lint everything**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test:unit`
Expected: PASS (all tasks' suites)

Run: `pnpm test:db` (needs Postgres)
Expected: PASS (includes Task 3's `pr-reviews` db-integration tests)

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 5: Re-read the design spec against what was built**

Walk `docs/superpowers/specs/2026-09-15-pr-review-github-comments-design.md` section by section
and confirm each decision has a corresponding task above (Detection → Task 7 Step 2; verdict/own-
PR fallback → Task 2; re-review incrementality → Task 6/7; large-diff caveat → Task 6/9; task
page → Task 9). Note any gap to the user rather than silently closing it.
