import { eq } from "drizzle-orm";
import type { Agent, AgentMode } from "@agentfactory/core";
import { db } from "../client";
import { agents } from "../schema";
import { newId } from "../id";

const MAX_NAME_LENGTH = 80;

function capName(name: string): string {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}

function toAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    orgId: row.orgId,
    teamId: row.teamId ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    avatarEmoji: row.avatarEmoji ?? undefined,
    systemPrompt: row.systemPrompt,
    model: row.model,
    mode: row.mode,
    runtimeKind: row.runtimeKind as Agent["runtimeKind"],
    toolPolicy: row.toolPolicy,
    skillIds: row.skillIds,
    connectionIds: row.connectionIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAgents(orgId: string): Promise<Agent[]> {
  const rows = await db.select().from(agents).where(eq(agents.orgId, orgId));
  return rows.map(toAgent);
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row ? toAgent(row) : undefined;
}

export interface NewAgentInput {
  name: string;
  description: string;
  systemPrompt: string;
  mode: AgentMode;
  teamId?: string;
}

export async function createAgent(orgId: string, input: NewAgentInput): Promise<Agent> {
  const [row] = await db
    .insert(agents)
    .values({
      id: newId("agent"),
      orgId,
      teamId: input.teamId ?? null,
      name: capName(input.name),
      description: input.description || null,
      avatarEmoji: "🤖",
      systemPrompt: input.systemPrompt,
      model: { family: "anthropic", id: "claude-sonnet-5", maxTokens: 8192 },
      mode: input.mode,
      runtimeKind: "claude-code",
      toolPolicy: { defaultDecision: "deny", rules: [] },
      skillIds: [],
      connectionIds: [],
    })
    .returning();
  return toAgent(row);
}

export async function updateAgent(
  agentId: string,
  patch: Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode" | "teamId">>,
): Promise<Agent | undefined> {
  const values: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = capName(patch.name);
  if (patch.description !== undefined) values.description = patch.description || null;
  if (patch.systemPrompt !== undefined) values.systemPrompt = patch.systemPrompt;
  if (patch.mode !== undefined) values.mode = patch.mode;
  if ("teamId" in patch) values.teamId = patch.teamId ?? null;

  const [row] = await db.update(agents).set(values).where(eq(agents.id, agentId)).returning();
  return row ? toAgent(row) : undefined;
}
