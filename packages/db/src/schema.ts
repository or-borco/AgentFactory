import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ModelSpec, ToolPolicy } from "@agentfactory/core";

// `generatedByDefaultAsIdentity` (not `generatedAlways`) so seed.ts can still assign explicit,
// stable ids for its fixture rows via `.overridingSystemValue()`, while app-created rows omit
// `id` and get the next value from the same Postgres sequence.
export const orgs = pgTable("orgs", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("agents_name_max_length", sql`char_length(${table.name}) <= 80`)],
);
