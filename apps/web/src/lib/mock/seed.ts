import type {
  ChatMessage,
  Connection,
  Session,
  Skill,
} from "@agentfactory/core";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

// Teams and agents no longer seed from here — see packages/db/src/seed.ts, which inserts the
// same fixture rows (same IDs) directly into Postgres. Sessions and messages below still
// reference those IDs by string, so the two seed sources must stay in sync by hand for now.
export const ORG_ID = "org_1";

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
