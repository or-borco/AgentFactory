import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import type {
  AcceptanceCriterion,
  ModelSpec,
  PromptSegment,
  RunCommitRange,
  RunEvalResult,
  TaskExternalRef,
  ToolPolicy,
} from "@agentfactory/core";

// `generatedByDefaultAsIdentity` (not `generatedAlways`) so seed.ts can still assign explicit,
// stable ids for its fixture rows via `.overridingSystemValue()`, while app-created rows omit
// `id` and get the next value from the same Postgres sequence.
export const orgs = pgTable("orgs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roleEnum = pgEnum("role", ["owner", "admin", "member"]);

// Composite PK (userId, orgId) — a user has at most one role per org, matching Membership in
// packages/core/src/domain.ts. No surrogate id: nothing else references a membership row.
export const memberships = pgTable(
  "memberships",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.orgId] })],
);

// Opaque bearer tokens for the login cookie. Only a SHA-256 hash of the token is stored — the
// raw token lives in the cookie and is never persisted — so a DB read doesn't hand out a usable
// session. Deleting the row (on logout) revokes it immediately, unlike a stateless JWT.
export const authSessions = pgTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teams = pgTable(
  "teams",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    // Small, hot, always injected into every prompt on the team — see ARCHITECTURE.md §2.3.
    // Large content goes to team_context_items (S3-backed) instead, not here.
    sharedContext: text("shared_context").notNull().default(""),
    githubTeamSlug: text("github_team_slug"),
    // Triggers a non-blocking repo-map pre-warm when set/changed (apps/worker's
    // repo-map-warm queue) — has no effect on which repo an agent or task actually uses.
    defaultCodebase: text("default_codebase"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("teams_name_max_length", sql`char_length(${table.name}) <= 80`),
    check("teams_shared_context_max_bytes", sql`octet_length(${table.sharedContext}) <= 65536`),
  ],
);

// A closed, stable set tied to core product semantics — a native enum pulls invalid values
// into a rejected write instead of an app-level bug. runtimeKind is deliberately NOT an enum:
// ARCHITECTURE.md §0/§1 expects more AgentRuntime adapters over time, and a plain text column
// (validated by the RuntimeKind TS union) doesn't need a migration to accept a new one.
export const agentModeEnum = pgEnum("agent_mode", ["manual", "automatic"]);

export const agents = pgTable(
  "agents",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    teamId: integer("team_id").references(() => teams.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    avatarEmoji: text("avatar_emoji"),
    systemPrompt: text("system_prompt").notNull(),
    model: jsonb("model").$type<ModelSpec>().notNull(),
    mode: agentModeEnum("mode").notNull().default("manual"),
    runtimeKind: text("runtime_kind").notNull().default("claude-code"),
    toolPolicy: jsonb("tool_policy").$type<ToolPolicy>().notNull(),
    connectionIds: jsonb("connection_ids").$type<number[]>().notNull().default([]),
    // What to do when a run's resumed session history overflows this agent's assigned model's
    // context window. "fallback" (default) escalates up the ladder in packages/core/src/models.ts;
    // "fail_fast" keeps the assigned model fixed and lets the run fail for real.
    onContextOverflow: text("on_context_overflow", { enum: ["fallback", "fail_fast"] })
      .notNull()
      .default("fallback"),
    // Intentionally unwired for alpha (issue #65): editing UI removed, nothing reads this.
    // Column kept to avoid a migration for no gain; do not build UI on top of it without a plan.
    areaMap: jsonb("area_map").$type<Record<string, string>>(),
    defaultCodebase: text("default_codebase"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("agents_name_max_length", sql`char_length(${table.name}) <= 80`)],
);

// A closed set matching Connection.kind/health in packages/core/src/domain.ts. provider is
// deliberately NOT an enum — ConnectionProvider is expected to grow (bitbucket, telegram, jira,
// ...), same reasoning as agents.runtimeKind above.
export const connectionKindEnum = pgEnum("connection_kind", ["scm", "channel", "tasks"]);
export const connectionHealthEnum = pgEnum("connection_health", ["healthy", "needs-attention", "expired"]);

// Mirrors ConnectionAuthKind in packages/core/src/domain.ts. "none" is the GitHub case: the
// platform App mints a scoped, hour-lived installation token on demand, so there is nothing to
// store. Every other provider has to persist something, which is what connection_secrets is for.
export const connectionAuthKindEnum = pgEnum("connection_auth_kind", ["none", "api_token", "oauth2"]);

// The vault ARCHITECTURE.md §2.7 calls for: "Credential lives in the vault; only a reference
// here." Deliberately a separate table rather than a column on `connections` — GET
// /api/connections returns connections.config verbatim to the browser, so anything on that row
// is one careless spread away from being public.
export const connectionSecrets = pgTable("connection_secrets", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  // AES-256-GCM: base64(iv[12] || authTag[16] || payload). keyVersion lets a future key rotation
  // be a re-encrypt migration rather than a schema change.
  ciphertext: text("ciphertext").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connections = pgTable("connections", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  kind: connectionKindEnum("kind").notNull(),
  label: text("label").notNull(),
  health: connectionHealthEnum("health").notNull().default("healthy"),
  // For github: { installationId, accountLogin, accountType }. No token/secret lives here —
  // installation tokens are minted on demand from the platform's GitHub App private key
  // (packages/scm/src/github.ts), never persisted.
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  auth: connectionAuthKindEnum("auth").notNull().default("none"),
  // Nullable, and "none" is the default, so every existing GitHub row is already correct with no
  // backfill. set null (not cascade) on secret deletion: losing the credential must degrade the
  // connection to unhealthy, not silently delete the user's configuration.
  credentialRef: integer("credential_ref").references(() => connectionSecrets.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionOriginEnum = pgEnum("session_origin", ["web", "slack", "github", "jira", "cron"]);

export const sessions = pgTable(
  "sessions",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    origin: sessionOriginEnum("origin").notNull().default("web"),
    externalThreadRef: text("external_thread_ref"),
    // The warm sandbox container id for this session's runs — see Session.sandboxId in
    // packages/core/src/domain.ts for why this is session-scoped, not run-scoped.
    sandboxId: text("sandbox_id"),
    // Folded into this session's git branch name (agent/session-<id>-<branchToken> — see
    // sessionBranchName in apps/worker/src/scm-provider.ts) so the branch stays unique even if
    // `id` collides with an unrelated session's id, which does happen: `id` is only unique
    // within this one database, but the branch name has to stay unique on whatever GitHub repo
    // the session's tasks target, and more than one database can point sandboxes at the same
    // repo (a second local dev DB, a reseed that reassigns an id — see T-051). Nullable because
    // sessions created before this column existed have no token; sessionBranchName falls back to
    // the bare id-only name for those.
    branchToken: text("branch_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Agent detail pages list sessions WHERE agent_id = ? — without this, a seq scan.
    index("sessions_agent_id_idx").on(table.agentId),
  ],
);

export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"]);

// No org_id here — reachable via session_id. RLS isn't implemented yet (same documented gap
// as teams/agents), so this isn't a new omission, just the same one.
export const messages = pgTable(
  "messages",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: chatRoleEnum("role").notNull(),
    content: text("content").notNull(),
    // Set only on assistant messages, to the run that produced them — the reverse of
    // runs.triggeringMessageId below. Nullable: user messages never have one. `references` uses
    // a lazy callback so this forward reference to `runs` (declared further down) resolves fine.
    runId: integer("run_id").references((): AnyPgColumn => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The chat transcript query is WHERE session_id = ? ORDER BY id — without this, a seq scan
    // on every poll tick, same problem as events below.
    index("messages_session_id_idx").on(table.sessionId),
  ],
);

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "provisioning",
  "running",
  "finalizing",
  "done",
  "failed",
  "cancelled",
]);

export const runs = pgTable(
  "runs",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    status: runStatusEnum("status").notNull().default("queued"),
    // The user message that caused this run — set at createRun time. Nullable: a future
    // trigger-driven automatic run (cron/webhook, per ARCHITECTURE.md §2.6) won't have one.
    triggeringMessageId: integer("triggering_message_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    // Unused until a real AgentRuntime adapter exists — see ARCHITECTURE.md §1 rule 3
    // ("provider session IDs live in runs.provider_session_ref, never in business logic").
    // Cheap to add now, avoids a migration later.
    providerSessionRef: text("provider_session_ref"),
    // The session's sandboxId at the moment providerSessionRef was recorded — resume state lives
    // in that specific container's filesystem, not server-side, so a later run may only resume
    // this ref if the session's CURRENT sandboxId still matches. Comparing against a snapshot
    // taken once per run (before vs. after that run's own ensureSandbox call) is not equivalent:
    // it only detects a recreation happening during that one run, not one that already happened
    // before it started and has since gone unnoticed across several failed runs in a row — see
    // docs/superpowers/specs/2026-09-08-session-context-reconstruction-design.md and its
    // follow-up fix. Null for runs that predate this column, which correctly never matches any
    // real sandboxId and so is always treated as "resume unsafe" — exactly the right default.
    sandboxId: text("sandbox_id"),
    promptHash: text("prompt_hash"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    tokensUsed: integer("tokens_used").notNull().default(0),
    budgetExceeded: boolean("budget_exceeded"),
    // Snapshot of /workspace at run completion: path → utf-8 content. Excludes node_modules and
    // binary files. Null until the run finishes or if the sandbox was unreachable at teardown.
    workspaceSnapshot: jsonb("workspace_snapshot").$type<Record<string, string>>(),
    // What this run added to the session's branch: the branch head before its push and after
    // (RunCommitRange in @agentfactory/core). Null when the run pushed nothing — and also for
    // runs that predate this column, which is why the eval path treats "no range but a
    // non-empty workspace_snapshot" as unknowable rather than as "committed nothing". Small
    // enough to sit in RUN_COLUMNS, unlike workspace_snapshot's sibling blobs below.
    commitRange: jsonb("commit_range").$type<RunCommitRange>(),
    // The exact system prompt this run's turn received, as ordered labeled segments
    // (PromptSegment in @agentfactory/core; join of texts === the sent string, and
    // prompt_hash on this row is the hash of that join). Null until the run composes
    // a prompt — and permanently null for runs that fail before that point, which is
    // itself diagnostic. Follows the workspaceSnapshot precedent for large per-run
    // jsonb; read only via getRunPrompt, never selected into Run.
    promptSegments: jsonb("prompt_segments").$type<PromptSegment[]>(),
    // The ModelSpec that actually executed this run's turn — may differ from the agent/task's
    // assigned model if context-overflow escalation (worker.ts) bumped it to a larger tier.
    // Null until the run resolves a model (never set for runs that fail before that point).
    model: jsonb("model").$type<ModelSpec>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // listRunsForSession and the events join below both filter WHERE session_id = ? —
    // without this, a seq scan on every ~1.5s task-page poll tick.
    index("runs_session_id_idx").on(table.sessionId),
  ],
);

export const evalStatusEnum = pgEnum("eval_status", ["queued", "running", "done", "failed"]);

// One row per judge invocation against a run — deliberately its own table, never columns on
// runs: a run can be evaluated repeatedly, and the task page polls runs on a ~1.5s timer
// (the workspaceSnapshot over-fetch lesson). org_id is denormalized so list queries are
// org-scoped without the runs → sessions → agents join.
export const runEvals = pgTable(
  "run_evals",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    status: evalStatusEnum("status").notNull().default("queued"),
    // RunEvalResult from @agentfactory/core; null until the eval reaches "done".
    result: jsonb("result").$type<RunEvalResult>(),
    // Which model graded — scores from different judges are not comparable, so every card says.
    judgeModelId: text("judge_model_id"),
    // Machine-readable failure reason (e.g. "artefact_unavailable"); null unless failed.
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    // listEvalsForRun filters WHERE run_id = ? AND org_id = ? — without this, every task-page
    // eval-history fetch is a sequential scan over the whole table.
    index("run_evals_run_id_idx").on(table.runId),
  ],
);

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

// ── Tasks ───────────────────────────────────────────────────────────────────────
// A Task is a human-authored unit of work (title, description, acceptance criteria) that
// owns 0..1 sessions. It cannot simply extend Session because an open/unassigned task has
// no agent (sessions.agent_id is NOT NULL). The task status is a separate axis from Run.status.
export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "assigned",
  "in_progress",
  "needs_input",
  "pr_open",
  "review_cycle",
  "done",
  "failed",
  "cancelled",
]);

export const tasks = pgTable(
  "tasks",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    // Display ref ("T-042") — set to "T-" + id in a post-insert update. Unique per org.
    ref: text("ref").notNull().default(""),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    acceptanceCriteria: jsonb("acceptance_criteria")
      .$type<AcceptanceCriterion[]>()
      .notNull()
      .default([]),
    status: taskStatusEnum("status").notNull().default("open"),
    assigneeAgentId: integer("assignee_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    // The owned session (0..1). null until "Start agent session" is invoked.
    sessionId: integer("session_id").references((): AnyPgColumn => sessions.id, {
      onDelete: "set null",
    }),
    area: text("area"),
    codebase: text("codebase"),
    // Per-task override of the assignee agent's default model. Null means "use the agent's model".
    model: jsonb("model").$type<ModelSpec>(),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    // The upstream issue this task mirrors, e.g. { provider: "jira", key: "PROJ-123", url: ... }.
    // Generic rather than a jira_issue_key column so Monday/Asana need no migration.
    externalRef: jsonb("external_ref").$type<TaskExternalRef>(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("tasks_title_max_length", sql`char_length(${t.title}) <= 200`),
    // The task page looks up the task owning a session via WHERE session_id = ? —
    // without this, a seq scan over every task in the org.
    index("tasks_session_id_idx").on(t.sessionId),
  ],
);

// The index over immutable file bytes; the bytes themselves live in a BlobStore (packages/storage).
// Keyed (org_id, sha256), never sha256 alone: two orgs uploading the same public RFC must own
// separate rows, or deleting one org cascades content out from under the other's still-referencing
// item. The org_id FK is also what makes this table reachable by the db-test harness's
// `truncate orgs ... cascade` — a hash-keyed table with no FK would leak rows between test files.
export const contentBlobs = pgTable(
  "content_blobs",
  {
    sha256: text("sha256").notNull(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    sizeBytes: integer("size_bytes").notNull(),
    mime: text("mime").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sha256] })],
);

export const skills = pgTable(
  "skills",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    source: text("source").notNull().default("authored"),
    currentVersionId: integer("current_version_id"),
    // Groups related, typically system-seeded skills (e.g. "superpowers") for display. Unset for
    // ordinary org-authored skills.
    family: text("family"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("skills_org_slug").on(t.orgId, t.slug)],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    skillId: integer("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    bodySha256: text("body_sha256").notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.bodySha256],
      foreignColumns: [contentBlobs.orgId, contentBlobs.sha256],
    }),
    uniqueIndex("skill_versions_draft_per_skill")
      .on(t.skillId)
      .where(sql`published_at IS NULL`),
  ],
);

export const agentSkills = pgTable(
  "agent_skills",
  {
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: integer("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    skillVersionId: integer("skill_version_id")
      .notNull()
      .references(() => skillVersions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
);

export const contextItemStatusEnum = pgEnum("context_item_status", [
  "pending",
  "indexing",
  "indexed",
  "failed",
]);

// A real uploaded document: metadata here, bytes in the blob store, chunks (PR 3) hanging off
// it. org_id is denormalized from the team so every scoping check is a column predicate rather
// than an innerJoin(teams, …) — and because the composite FK to content_blobs needs it, blobs
// being partitioned per org.
export const teamContextItems = pgTable(
  "team_context_items",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    // Always "upload" today; connectors (Drive, Notion, URLs) become other values, not columns.
    source: text("source").notNull().default("upload"),
    status: contextItemStatusEnum("status").notNull().default("pending"),
    // Ingestion's failure message; null unless status is "failed".
    error: text("error"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.sha256],
      foreignColumns: [contentBlobs.orgId, contentBlobs.sha256],
    }),
    // Per team, not per org: one org may want the same handbook in two teams, but one team must
    // never hold the same bytes twice — both copies would match retrieval and spend the budget.
    uniqueIndex("team_context_items_team_sha").on(t.teamId, t.sha256),
  ],
);

// One embedded window of a context item's text. Chunks are derived data, never a source of
// truth — the original bytes live in content_blobs, so a re-chunk or a model swap is a delete
// plus a re-insert, which is why ingestion deletes an item's chunks before writing new ones.
export const contextChunks = pgTable(
  "context_chunks",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    itemId: integer("item_id")
      .notNull()
      .references(() => teamContextItems.id, { onDelete: "cascade" }),
    // Denormalized from the item. Retrieval always filters on it, and a filtered HNSW scan
    // wants the predicate on the indexed table rather than behind a join to team_context_items.
    teamId: integer("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    chunkIdx: integer("chunk_idx").notNull(),
    text: text("text").notNull(),
    // 384 dimensions, following the embedder (Xenova/bge-small-en-v1.5) rather than
    // ARCHITECTURE.md §2.4's vector(1536), which assumed an OpenAI model. The column's width is
    // fixed and the HNSW index needs it fixed, so the model and the schema move together.
    embedding: vector("embedding", { dimensions: 384 }).notNull(),
    // Stamped per row so a mixed-model corpus is detectable rather than silently mis-ranked.
    // The backfill command that acts on a mismatch is deliberately not built yet.
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("context_chunks_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("context_chunks_team_id_idx").on(table.teamId),
  ],
);

// Task-scoped twin of team_context_items — same addressing scheme (org_id denormalized, composite
// FK to content_blobs), same status machine, but keyed by task_id instead of team_id. Deliberately
// its own table rather than a nullable team_id/task_id union on the existing one: retrieval, the
// worker, and the routes all key off exactly one of the two, and a shared table would make every
// query there carry a redundant "and the other id is null" predicate. Unwired for now — no route,
// no worker, no retrieval reads this table yet.
export const taskContextItems = pgTable(
  "task_context_items",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    sha256: text("sha256").notNull(),
    mime: text("mime").notNull(),
    // Always "upload" today; connectors (Drive, Notion, URLs) become other values, not columns.
    source: text("source").notNull().default("upload"),
    status: contextItemStatusEnum("status").notNull().default("pending"),
    // Ingestion's failure message; null unless status is "failed".
    error: text("error"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.sha256],
      foreignColumns: [contentBlobs.orgId, contentBlobs.sha256],
    }),
    // Per task, not per org: one org may want the same handbook attached to two tasks, but one
    // task must never hold the same bytes twice — both copies would match retrieval and spend
    // the budget.
    uniqueIndex("task_context_items_task_sha").on(t.taskId, t.sha256),
  ],
);

// Task-scoped twin of context_chunks. A separate table from context_chunks rather than a shared
// one for the same reason as task_context_items above — retrieval always filters on exactly one
// of team_id/task_id, and the HNSW scan wants that predicate on its own indexed table.
export const taskContextChunks = pgTable(
  "task_context_chunks",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    itemId: integer("item_id")
      .notNull()
      .references(() => taskContextItems.id, { onDelete: "cascade" }),
    // Denormalized from the item, same reasoning as context_chunks.team_id: a filtered HNSW scan
    // wants the predicate on the indexed table rather than behind a join to task_context_items.
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    chunkIdx: integer("chunk_idx").notNull(),
    text: text("text").notNull(),
    // Same 384 dimensions as context_chunks, following the same embedder.
    embedding: vector("embedding", { dimensions: 384 }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("task_context_chunks_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("task_context_chunks_task_id_idx").on(table.taskId),
  ],
);

// Disambiguates which items table item_id points into, now that there are two (team and task).
// See the note on itemId below for why this can't be a DB-level FK.
export const contextItemKindEnum = pgEnum("context_item_kind", ["team", "task"]);

// What retrieval actually injected into one run. Deliberately its own table, never columns on
// runs: the task page polls runs on a ~1.5s timer and RUN_COLUMNS exists to keep large per-run
// payloads off that poll, so this is fetched lazily on tab open — the same arrangement as
// run_evals. No run event is emitted for these rows: the task page keys context_included by
// runId with last-write-wins, so a second one would overwrite the shared-context indicator.
export const runContextRetrievals = pgTable(
  "run_context_retrievals",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // No .references() — itemId can point at either team_context_items or task_context_items,
    // and the two id spaces collide (both are independent identity sequences starting at 1), so
    // a single FK can't disambiguate which table it targets. Nulled explicitly by both
    // deleteTeamContextItemForOrg and deleteTaskContextItemForOrg (filtered by itemKind too),
    // replacing the FK's old ON DELETE SET NULL.
    itemId: integer("item_id"),
    itemKind: contextItemKindEnum("item_kind").notNull().default("team"),
    // Snapshot of the document's title at retrieval time — survives the delete above.
    itemTitle: text("item_title").notNull(),
    chunkIdx: integer("chunk_idx").notNull(),
    rank: integer("rank").notNull(),
    score: doublePrecision("score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The only query shape: WHERE run_id = ?, ordered by rank.
    index("run_context_retrievals_run_id_idx").on(table.runId),
  ],
);

// No monthly partitioning yet — ARCHITECTURE.md flags this as "the one table that will hurt"
// at scale, but partitioning tooling for zero rows is pure overhead. Revisit when it's real.
export const events = pgTable(
  "events",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    runId: integer("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    // Matches RunEvent["type"] from packages/core/src/events.ts (text, not an enum — the event
    // type union is expected to grow as real runtimes land, same reasoning as agents.runtimeKind).
    type: text("type").notNull(),
    // Type-specific fields only (e.g. {text} for text_delta, {reason} for done) — id/runId/seq/
    // createdAt are already real columns, not duplicated in here.
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // listEventsForSession joins events -> runs ON events.run_id and orders by (run_id, seq) —
    // this composite index covers both the join and the sort, and also makes a future
    // WHERE run_id = ? AND seq > ? cursor query (see the polling-cursor sibling issue) an
    // index range scan instead of a filter. The append-only, ever-growing events table is the
    // hottest table in the schema: the task page polls this join every ~1.5s.
    index("events_run_id_seq_idx").on(table.runId, table.seq),
  ],
);

// Auto-generated CLAUDE.md-style summary of a repo, cached per exact commit so it self-
// invalidates the moment the code moves on — see docs/superpowers/specs/
// 2026-08-23-repo-map-indexing-design.md. Plain text, not S3/content-addressed, following
// teams.sharedContext's reasoning (small, hot, read on every run) rather than the
// skills-bundle pattern.
export const repoMaps = pgTable(
  "repo_maps",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    commitSha: text("commit_sha").notNull(),
    content: text("content").notNull(),
    generationCostUsd: doublePrecision("generation_cost_usd").notNull().default(0),
    generationTokens: integer("generation_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("repo_maps_org_repo_sha").on(table.orgId, table.repoFullName, table.commitSha),
    check("repo_maps_content_max_length", sql`char_length(${table.content}) <= 16384`),
  ],
);
