import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AcceptanceCriterion, ModelSpec, ToolPolicy } from "@agentfactory/core";

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
    // Plain ID arrays for now, not join tables (agent_skills/agent_connections per §2.5/§2.7) —
    // those pin skill *versions* and connection *scopes*, which don't exist yet since Skills
    // and Connections have no real backend of their own. Revisit when they get one.
    skillIds: jsonb("skill_ids").$type<number[]>().notNull().default([]),
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
  // (apps/web/src/server/github-app.ts), never persisted.
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessionOriginEnum = pgEnum("session_origin", ["web", "slack", "github", "jira", "cron"]);

export const sessions = pgTable("sessions", {
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant"]);

// No org_id here — reachable via session_id. RLS isn't implemented yet (same documented gap
// as teams/agents), so this isn't a new omission, just the same one.
export const messages = pgTable("messages", {
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
});

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "provisioning",
  "running",
  "finalizing",
  "done",
  "failed",
  "cancelled",
]);

export const runs = pgTable("runs", {
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
  promptHash: text("prompt_hash"),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  tokensUsed: integer("tokens_used").notNull().default(0),
  budgetExceeded: boolean("budget_exceeded"),
  // Snapshot of /workspace at run completion: path → utf-8 content. Excludes node_modules and
  // binary files. Null until the run finishes or if the sandbox was unreachable at teardown.
  workspaceSnapshot: jsonb("workspace_snapshot").$type<Record<string, string>>(),
  // The ModelSpec that actually executed this run's turn — may differ from the agent/task's
  // assigned model if context-overflow escalation (worker.ts) bumped it to a larger tier.
  // Null until the run resolves a model (never set for runs that fail before that point).
  model: jsonb("model").$type<ModelSpec>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

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
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("tasks_title_max_length", sql`char_length(${t.title}) <= 200`),
  ],
);

// Metadata-only stubs for now (no S3/upload yet). Large reference docs the team shares with
// agents — tracked here for the usage meter and future indexing pipeline.
export const teamContextItems = pgTable("team_context_items", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  teamId: integer("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// No monthly partitioning yet — ARCHITECTURE.md flags this as "the one table that will hurt"
// at scale, but partitioning tooling for zero rows is pure overhead. Revisit when it's real.
export const events = pgTable("events", {
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
});
