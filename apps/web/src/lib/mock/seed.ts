import type { Connection, Skill } from "@agentfactory/core";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

// Teams, agents, sessions, and messages no longer seed from here — see packages/db/src/seed.ts,
// which inserts the same fixture rows (same IDs) directly into Postgres.
export const ORG_ID = 1;

export const seedSkills: Skill[] = [
  {
    id: 1,
    orgId: ORG_ID,
    name: "Conventional commits",
    slug: "conventional-commits",
    description: "Validate and format commit messages against the Conventional Commits spec",
    source: "authored",
    currentVersionId: 1,
    createdAt: hoursAgo(500),
  },
  {
    id: 2,
    orgId: ORG_ID,
    name: "Python style guide",
    slug: "python-style-guide",
    description: "The team's PEP8 conventions and docstring format, imported from the platform repo",
    source: "git",
    currentVersionId: 2,
    createdAt: hoursAgo(300),
  },
];

export const seedConnections: Connection[] = [
  {
    id: 1,
    orgId: ORG_ID,
    provider: "github",
    kind: "scm",
    label: "acme-org/platform",
    health: "healthy",
    config: {},
    createdAt: hoursAgo(500),
  },
  {
    id: 2,
    orgId: ORG_ID,
    provider: "slack",
    kind: "channel",
    label: "#eng-agents",
    health: "healthy",
    config: {},
    createdAt: hoursAgo(300),
  },
  {
    id: 3,
    orgId: ORG_ID,
    provider: "jira",
    kind: "tasks",
    label: "PLAT project",
    health: "needs-attention",
    config: {},
    createdAt: hoursAgo(100),
  },
];
