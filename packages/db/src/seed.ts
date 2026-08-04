import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { agents, events, memberships, messages, orgs, runs, sessions, tasks, teamContextItems, teams, users } from "./schema";
import { hashPassword } from "./password";

// Mirrors apps/web/src/lib/mock/seed.ts's seedTeams/seedAgents exactly (same IDs), so the
// mock's still-in-memory seedSessions/seedMessages — which reference these agent/team IDs by
// number — keep resolving correctly once agents and teams move to Postgres.
//
// Ids below are explicit (via .overridingSystemValue()) so they stay stable across reseeds
// instead of depending on insertion order. Explicit inserts into an identity column don't
// advance its sequence, so resetIdentitySequence() bumps each one past its max seeded id —
// otherwise the first app-created row (createTeam/createAgent) would collide with a seed id.
const ORG_ID = 1;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

async function resetIdentitySequence(db: ReturnType<typeof drizzle>, table: string) {
  await db.execute(
    sql`select setval(pg_get_serial_sequence(${table}, 'id'), coalesce((select max(id) from ${sql.raw(table)}), 1))`,
  );
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const sql_ = postgres(connectionString, { max: 1 });
  const db = drizzle(sql_);

  await db
    .insert(orgs)
    .overridingSystemValue()
    .values({ id: ORG_ID, name: "Acme Corp", slug: "acme", createdAt: hoursAgo(500) })
    .onConflictDoNothing();

  // Dev login: demo@acme.test / password
  await db
    .insert(users)
    .overridingSystemValue()
    .values({
      id: 1,
      email: "demo@acme.test",
      name: "Demo User",
      passwordHash: await hashPassword("password"),
      createdAt: hoursAgo(500),
    })
    .onConflictDoNothing();

  await db
    .insert(memberships)
    .values({ userId: 1, orgId: ORG_ID, role: "owner", createdAt: hoursAgo(500) })
    .onConflictDoNothing();

  await db
    .insert(teams)
    .overridingSystemValue()
    .values([
      {
        id: 1,
        orgId: ORG_ID,
        name: "Platform team",
        description: "Core services and internal tooling",
        sharedContext:
          "Stack: TypeScript, Next.js, Postgres. All PRs require a passing test suite and at least one review. " +
          "Follow the repo's ESLint config; do not disable rules inline without a comment explaining why. " +
          "Prefer small, focused PRs over large ones.",
        createdAt: hoursAgo(400),
      },
      {
        id: 2,
        orgId: ORG_ID,
        name: "Projects team",
        sharedContext: "",
        createdAt: hoursAgo(3),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(agents)
    .overridingSystemValue()
    .values([
      {
        id: 1,
        orgId: ORG_ID,
        teamId: 1,
        name: "Code reviewer",
        description: "Perform code review",
        avatarEmoji: "🤖",
        systemPrompt: "Perform code review for pull request according to the team's standards",
        model: { family: "anthropic", id: "claude-sonnet-5", maxTokens: 8192 },
        mode: "automatic",
        runtimeKind: "claude-code",
        toolPolicy: {
          defaultDecision: "deny",
          rules: [
            { tool: "read_file", decision: "allow" },
            { tool: "comment_pr", decision: "allow" },
            { tool: "merge_pr", decision: "deny" },
          ],
        },
        skillIds: [1],
        connectionIds: [1],
        areaMap: { "apps/web/": "Next.js frontend", "packages/": "Shared packages" },
        defaultCodebase: "acme-corp/backend",
        createdAt: hoursAgo(400),
        updatedAt: hoursAgo(3),
      },
      {
        id: 2,
        orgId: ORG_ID,
        teamId: 1,
        name: "Release notes writer",
        description: "Draft release notes from merged PRs",
        avatarEmoji: "📝",
        systemPrompt:
          "Summarize merged pull requests since the last tag into concise, user-facing release notes grouped by " +
          "feature, fix, and chore.",
        model: { family: "anthropic", id: "claude-sonnet-5", maxTokens: 4096 },
        mode: "manual",
        runtimeKind: "claude-code",
        toolPolicy: { defaultDecision: "deny", rules: [] },
        skillIds: [],
        connectionIds: [1],
        defaultCodebase: "acme-corp/backend",
        createdAt: hoursAgo(200),
        updatedAt: hoursAgo(200),
      },
      {
        id: 3,
        orgId: ORG_ID,
        teamId: 1,
        name: "Support triager",
        description: "Label and route incoming support tickets",
        avatarEmoji: "🎧",
        systemPrompt:
          "Read new support tickets, assign a priority and category label, and route to the correct team channel.",
        model: { family: "anthropic", id: "claude-sonnet-5", maxTokens: 4096 },
        mode: "automatic",
        runtimeKind: "claude-code",
        toolPolicy: { defaultDecision: "deny", rules: [] },
        skillIds: [],
        connectionIds: [],
        createdAt: hoursAgo(120),
        updatedAt: hoursAgo(50),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(sessions)
    .overridingSystemValue()
    .values([
      {
        id: 1,
        orgId: ORG_ID,
        agentId: 1,
        title: "New conversation",
        origin: "web",
        createdAt: hoursAgo(3),
        lastActivityAt: hoursAgo(3),
      },
      {
        id: 2,
        orgId: ORG_ID,
        agentId: 1,
        title: "Please review PR 1234",
        origin: "web",
        createdAt: hoursAgo(3),
        lastActivityAt: hoursAgo(3),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(messages)
    .overridingSystemValue()
    .values([
      {
        id: 1,
        sessionId: 2,
        role: "user",
        content: "Please review PR 1234",
        createdAt: hoursAgo(3),
      },
      {
        id: 2,
        sessionId: 2,
        role: "assistant",
        content:
          "I looked over PR 1234. Two things worth a second look: the new `parseConfig` function doesn't handle a " +
          "missing `timeout` field (falls through to `undefined` instead of the documented default), and the added " +
          "test only covers the happy path. Everything else looks solid — types are precise and the diff is scoped " +
          "well. I left inline comments on both.",
        createdAt: hoursAgo(3),
      },
    ])
    .onConflictDoNothing();

  // ── Seed run + events for session 2 (PR review) — used to develop tool call / thinking UI ──
  await db
    .insert(runs)
    .overridingSystemValue()
    .values({
      id: 1,
      sessionId: 2,
      status: "done",
      triggeringMessageId: 1,
      costUsd: 0,
      tokensUsed: 0,
      createdAt: hoursAgo(3),
      finishedAt: hoursAgo(3),
    })
    .onConflictDoNothing();

  await db
    .insert(events)
    .overridingSystemValue()
    .values([
      { id: 1, runId: 1, seq: 0, type: "thinking_delta", data: { text: "The user wants me to review PR 1234. I should fetch the diff and check for correctness, test coverage, and style issues." }, createdAt: hoursAgo(3) },
      { id: 2, runId: 1, seq: 1, type: "tool_call",      data: { tool: "read_file", input: { path: "src/config/parseConfig.ts" } }, createdAt: hoursAgo(3) },
      { id: 3, runId: 1, seq: 2, type: "tool_result",    data: { tool: "read_file", output: "export function parseConfig(raw) { return { timeout: raw.timeout }; }", isError: false }, createdAt: hoursAgo(3) },
      { id: 4, runId: 1, seq: 3, type: "tool_call",      data: { tool: "comment_pr", input: { prNumber: 1234, body: "parseConfig doesn't default `timeout` — falls through to undefined." } }, createdAt: hoursAgo(3) },
      { id: 5, runId: 1, seq: 4, type: "tool_result",    data: { tool: "comment_pr", output: { commentId: 99 }, isError: false }, createdAt: hoursAgo(3) },
      { id: 6, runId: 1, seq: 5, type: "text_delta",     data: { text: "I looked over PR 1234…" }, createdAt: hoursAgo(3) },
      { id: 7, runId: 1, seq: 6, type: "done",           data: { reason: "completed" }, createdAt: hoursAgo(3) },
    ])
    .onConflictDoNothing();

  // ── Team context items ─────────────────────────────────────────────────────────
  await db
    .insert(teamContextItems)
    .overridingSystemValue()
    .values([
      { id: 1, teamId: 1, title: "Engineering handbook", sizeBytes: 18200, createdAt: hoursAgo(300) },
      { id: 2, teamId: 1, title: "API design guidelines", sizeBytes: 9400, createdAt: hoursAgo(200) },
      { id: 3, teamId: 1, title: "Incident runbooks", sizeBytes: 31500, createdAt: hoursAgo(100) },
    ])
    .onConflictDoNothing();

  // ── Tasks ──────────────────────────────────────────────────────────────────────
  // Mirrors the prototype's T-035…T-042 rows, covering every TaskStatus.
  await db
    .insert(tasks)
    .overridingSystemValue()
    .values([
      {
        id: 35,
        orgId: ORG_ID,
        ref: "T-035",
        title: "Add OAuth2 refresh-token rotation",
        description: "Implement silent refresh so users aren't logged out mid-session.",
        acceptanceCriteria: [
          { text: "Refresh token stored encrypted at rest", done: true },
          { text: "Silent refresh triggers <60 s before expiry", done: true },
          { text: "Unit tests for rotation logic", done: false },
        ],
        status: "open",
        area: "src/auth/",
        codebase: "acme-corp/backend",
        createdBy: 1,
        createdAt: hoursAgo(72),
        updatedAt: hoursAgo(72),
      },
      {
        id: 36,
        orgId: ORG_ID,
        ref: "T-036",
        title: "Migrate search index to Postgres full-text",
        description: "Replace Algolia with tsvector-based search to cut costs.",
        acceptanceCriteria: [
          { text: "All search endpoints return results within 200 ms", done: false },
          { text: "Algolia SDK removed from dependencies", done: false },
        ],
        status: "assigned",
        assigneeAgentId: 2,
        area: "src/search/",
        codebase: "acme-corp/backend",
        createdBy: 1,
        createdAt: hoursAgo(48),
        updatedAt: hoursAgo(48),
      },
      {
        id: 37,
        orgId: ORG_ID,
        ref: "T-037",
        title: "Refactor billing webhook handler",
        description: "Harden Stripe webhook processing with idempotency keys.",
        acceptanceCriteria: [
          { text: "Idempotency enforced on all event types", done: false },
          { text: "Failed events logged to dead-letter queue", done: false },
        ],
        status: "assigned",
        assigneeAgentId: 1,
        area: "src/billing/",
        codebase: "acme-corp/backend",
        createdBy: 1,
        createdAt: hoursAgo(36),
        updatedAt: hoursAgo(36),
      },
      {
        id: 38,
        orgId: ORG_ID,
        ref: "T-038",
        title: "Paginate /api/activity endpoint",
        description: "The activity endpoint loads all rows — add cursor-based pagination.",
        acceptanceCriteria: [
          { text: "Cursor pagination with next_cursor token", done: true },
          { text: "Default page size 25, max 100", done: true },
          { text: "Backward-compatible: existing callers work with limit param", done: true },
        ],
        status: "done",
        assigneeAgentId: 1,
        sessionId: 1,
        area: "src/api/",
        codebase: "acme-corp/backend",
        prNumber: 218,
        prUrl: "https://github.com/acme-corp/backend/pull/218",
        createdBy: 1,
        createdAt: hoursAgo(120),
        updatedAt: hoursAgo(24),
      },
      {
        id: 39,
        orgId: ORG_ID,
        ref: "T-039",
        title: "Add dark mode to the design system",
        description: "Implement CSS custom-property-based dark mode with a user toggle.",
        acceptanceCriteria: [
          { text: "Dark and light tokens defined in globals.css", done: true },
          { text: "Toggle persisted in localStorage", done: false },
          { text: "All existing components pass contrast checks", done: false },
        ],
        status: "needs_input",
        assigneeAgentId: 2,
        sessionId: 2,
        area: "src/styles/",
        codebase: "acme-corp/frontend",
        createdBy: 1,
        createdAt: hoursAgo(96),
        updatedAt: hoursAgo(8),
      },
      {
        id: 40,
        orgId: ORG_ID,
        ref: "T-040",
        title: "Set up E2E test suite with Playwright",
        description: "Add Playwright for critical user flows: login, checkout, order status.",
        acceptanceCriteria: [
          { text: "Login flow covered", done: true },
          { text: "Checkout flow covered", done: false },
          { text: "Order status flow covered", done: false },
          { text: "CI runs on every PR", done: false },
        ],
        status: "in_progress",
        assigneeAgentId: 3,
        area: "tests/e2e/",
        codebase: "acme-corp/frontend",
        createdBy: 1,
        createdAt: hoursAgo(24),
        updatedAt: hoursAgo(1),
      },
      {
        id: 41,
        orgId: ORG_ID,
        ref: "T-041",
        title: "Extract shared Button component",
        description: "Move the Button into packages/shared and update all import sites.",
        acceptanceCriteria: [
          { text: "Button exported from @agentfactory/shared", done: false },
          { text: "All usages updated", done: false },
        ],
        status: "pr_open",
        assigneeAgentId: 1,
        area: "packages/shared/",
        codebase: "acme-corp/frontend",
        prNumber: 221,
        prUrl: "https://github.com/acme-corp/frontend/pull/221",
        createdBy: 1,
        createdAt: hoursAgo(30),
        updatedAt: hoursAgo(4),
      },
      {
        id: 42,
        orgId: ORG_ID,
        ref: "T-042",
        title: "Write DB migration guide for v2 schema",
        description: "Document the steps to migrate from v1 schema to v2, including rollback.",
        acceptanceCriteria: [
          { text: "Step-by-step migration script included", done: false },
          { text: "Rollback procedure documented", done: false },
        ],
        status: "review_cycle",
        assigneeAgentId: 2,
        prNumber: 219,
        prUrl: "https://github.com/acme-corp/backend/pull/219",
        area: "docs/",
        codebase: "acme-corp/backend",
        createdBy: 1,
        createdAt: hoursAgo(60),
        updatedAt: hoursAgo(12),
      },
    ])
    .onConflictDoNothing();

  await resetIdentitySequence(db, "team_context_items");
  await resetIdentitySequence(db, "orgs");
  await resetIdentitySequence(db, "users");
  await resetIdentitySequence(db, "teams");
  await resetIdentitySequence(db, "agents");
  await resetIdentitySequence(db, "sessions");
  await resetIdentitySequence(db, "messages");
  await resetIdentitySequence(db, "runs");
  await resetIdentitySequence(db, "events");
  await resetIdentitySequence(db, "tasks");

  await sql_.end();
  console.log("Seed complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
