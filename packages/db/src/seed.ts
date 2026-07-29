import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { agents, orgs, teams } from "./schema";

// Mirrors apps/web/src/lib/mock/seed.ts's seedTeams/seedAgents exactly (same IDs), so the
// mock's still-in-memory seedSessions/seedMessages — which reference these agent/team IDs by
// string — keep resolving correctly once agents and teams move to Postgres.
const ORG_ID = "org_1";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);

  await db
    .insert(orgs)
    .values({ id: ORG_ID, name: "Acme Corp", slug: "acme", createdAt: hoursAgo(500) })
    .onConflictDoNothing();

  await db
    .insert(teams)
    .values([
      {
        id: "team_platform",
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
        id: "team_projects",
        orgId: ORG_ID,
        name: "Projects team",
        sharedContext: "",
        createdAt: hoursAgo(3),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(agents)
    .values([
      {
        id: "agent_code_reviewer",
        orgId: ORG_ID,
        teamId: "team_platform",
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
        skillIds: ["skill_conventional_commits"],
        connectionIds: ["conn_github"],
        createdAt: hoursAgo(400),
        updatedAt: hoursAgo(3),
      },
      {
        id: "agent_release_notes",
        orgId: ORG_ID,
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
        connectionIds: ["conn_github"],
        createdAt: hoursAgo(200),
        updatedAt: hoursAgo(200),
      },
      {
        id: "agent_support_triager",
        orgId: ORG_ID,
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

  await sql.end();
  console.log("Seed complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
