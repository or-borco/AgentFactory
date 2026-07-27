import type {
  Agent,
  ChatMessage,
  Connection,
  Session,
  Skill,
  Team,
} from "@agentfactory/core";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

export const ORG_ID = "org_1";

export const seedTeams: Team[] = [
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
];

export const seedAgents: Agent[] = [
  {
    id: "agent_code_reviewer",
    orgId: ORG_ID,
    teamId: "team_platform",
    name: "Code reviewer",
    description: "Perform code review",
    avatarEmoji: "🤖",
    systemPrompt:
      "Perform code review for pull request according to the team's standards",
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
];

export const seedSessions: Session[] = [
  {
    id: "session_new",
    agentId: "agent_code_reviewer",
    title: "New conversation",
    origin: "web",
    createdAt: hoursAgo(3),
    lastActivityAt: hoursAgo(3),
  },
  {
    id: "session_pr_1234",
    agentId: "agent_code_reviewer",
    title: "Please review PR 1234",
    origin: "web",
    createdAt: hoursAgo(3),
    lastActivityAt: hoursAgo(3),
  },
];

export const seedMessages: ChatMessage[] = [
  {
    id: "msg_1",
    sessionId: "session_pr_1234",
    role: "user",
    content: "Please review PR 1234",
    createdAt: hoursAgo(3),
  },
  {
    id: "msg_2",
    sessionId: "session_pr_1234",
    role: "assistant",
    content:
      "I looked over PR 1234. Two things worth a second look: the new `parseConfig` function doesn't handle a " +
      "missing `timeout` field (falls through to `undefined` instead of the documented default), and the added " +
      "test only covers the happy path. Everything else looks solid — types are precise and the diff is scoped " +
      "well. I left inline comments on both.",
    createdAt: hoursAgo(3),
  },
];

export const seedSkills: Skill[] = [
  {
    id: "skill_conventional_commits",
    orgId: ORG_ID,
    name: "Conventional commits",
    slug: "conventional-commits",
    description: "Validate and format commit messages against the Conventional Commits spec",
    source: "authored",
    currentVersionId: "skillv_1",
    createdAt: hoursAgo(500),
  },
  {
    id: "skill_python_style",
    orgId: ORG_ID,
    name: "Python style guide",
    slug: "python-style-guide",
    description: "The team's PEP8 conventions and docstring format, imported from the platform repo",
    source: "git",
    currentVersionId: "skillv_2",
    createdAt: hoursAgo(300),
  },
];

export const seedConnections: Connection[] = [
  {
    id: "conn_github",
    orgId: ORG_ID,
    provider: "github",
    kind: "scm",
    label: "acme-org/platform",
    health: "healthy",
    config: {},
    createdAt: hoursAgo(500),
  },
  {
    id: "conn_slack",
    orgId: ORG_ID,
    provider: "slack",
    kind: "channel",
    label: "#eng-agents",
    health: "healthy",
    config: {},
    createdAt: hoursAgo(300),
  },
  {
    id: "conn_jira",
    orgId: ORG_ID,
    provider: "jira",
    kind: "tasks",
    label: "PLAT project",
    health: "needs-attention",
    config: {},
    createdAt: hoursAgo(100),
  },
];
