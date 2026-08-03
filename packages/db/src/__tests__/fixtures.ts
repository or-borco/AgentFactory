import { randomUUID } from "node:crypto";
import type { Agent, AgentMode, Membership, Org, Role, Session, Task, Team, User } from "@agentfactory/core";
import { createAgent } from "../repositories/agents.js";
import { createMembership } from "../repositories/memberships.js";
import { createOrg } from "../repositories/orgs.js";
import { createSession } from "../repositories/sessions.js";
import { createTask } from "../repositories/tasks.js";
import { createTeam } from "../repositories/teams.js";
import { createUser } from "../repositories/users.js";
import { hashPassword } from "../password.js";

function suffix(): string {
  return randomUUID().slice(0, 8);
}

export async function insertOrg(overrides: Partial<{ name: string; slug: string }> = {}): Promise<Org> {
  const id = suffix();
  return createOrg(overrides.name ?? `Test Org ${id}`, overrides.slug ?? `test-org-${id}`);
}

export async function insertUser(
  overrides: Partial<{ email: string; name: string; password: string }> = {},
): Promise<User> {
  return createUser({
    email: overrides.email ?? `test-${suffix()}@example.com`,
    name: overrides.name ?? "Test User",
    passwordHash: await hashPassword(overrides.password ?? "password123"),
  });
}

export async function insertMembership(
  orgId: number,
  userId: number,
  role: Role = "member",
): Promise<Membership> {
  return createMembership({ orgId, userId, role });
}

export async function insertTeam(
  orgId: number,
  overrides: Partial<{ name: string; description: string }> = {},
): Promise<Team> {
  return createTeam(orgId, overrides.name ?? "Test Team", overrides.description ?? "");
}

export async function insertAgent(
  orgId: number,
  overrides: Partial<{
    name: string;
    description: string;
    systemPrompt: string;
    mode: AgentMode;
    teamId: number;
  }> = {},
): Promise<Agent> {
  return createAgent(orgId, {
    name: overrides.name ?? "Test Agent",
    description: overrides.description ?? "",
    systemPrompt: overrides.systemPrompt ?? "Be helpful.",
    mode: overrides.mode ?? "manual",
    teamId: overrides.teamId,
  });
}

export async function insertSession(orgId: number, agentId: number, title = "Test session"): Promise<Session> {
  return createSession(orgId, agentId, title);
}

export async function insertTask(
  orgId: number,
  createdBy: number,
  overrides: Partial<{ title: string; description: string; codebase: string; assigneeAgentId: number }> = {},
): Promise<Task> {
  return createTask(orgId, createdBy, {
    title: overrides.title ?? "Test task",
    description: overrides.description ?? "",
    acceptanceCriteria: [],
    codebase: overrides.codebase,
    assigneeAgentId: overrides.assigneeAgentId,
  });
}
