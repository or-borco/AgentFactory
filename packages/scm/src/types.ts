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

// Human-readable feedback on a PR as a dev agent needs it: general conversation comments, review
// summary bodies, and inline code comments, flattened into one list sorted oldest first. Distinct
// from ReviewComment, which is inline-only and exists for review runs' de-duplication.
export interface PullRequestFeedbackComment {
  kind: "conversation" | "review" | "inline";
  author: string;
  body: string;
  createdAt: string;
  // inline only
  path?: string;
  line?: number | null;
  // review only: GitHub's review state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED)
  reviewState?: string;
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
  detectPrimaryLanguage(connection: Connection, repoFullName: string): Promise<string | undefined>;
  fetchCommitRangeDiff(target: CloneTarget, range: RunCommitRange): Promise<string>;
  openDraftPullRequest(
    connection: Connection,
    repoFullName: string,
    branch: string,
    title: string,
    body: string,
  ): Promise<OpenedPullRequest>;
  parseIssueReference(text: string): { repoFullName: string; issueNumber: number } | undefined;
  fetchPullRequest(connection: Connection, repoFullName: string, prNumber: number): Promise<PullRequestInfo>;
  fetchReviewThreads(connection: Connection, repoFullName: string, prNumber: number): Promise<ReviewComment[]>;
  fetchPullRequestFeedback(
    connection: Connection,
    repoFullName: string,
    prNumber: number,
  ): Promise<PullRequestFeedbackComment[]>;
  postReview(
    connection: Connection,
    repoFullName: string,
    prNumber: number,
    review: ReviewToPost,
  ): Promise<PostedReview>;
  parsePullRequestReference(text: string): { repoFullName: string; prNumber: number } | undefined;
}
