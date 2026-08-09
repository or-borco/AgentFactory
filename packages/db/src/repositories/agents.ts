import { eq } from "drizzle-orm";
import type { Agent, AgentMode } from "@agentfactory/core";
import { buildModelSpec } from "@agentfactory/core";
import { db } from "../client";
import { agents } from "../schema";

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
    areaMap: row.areaMap ?? undefined,
    defaultCodebase: row.defaultCodebase ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAgents(orgId: number): Promise<Agent[]> {
  const rows = await db.select().from(agents).where(eq(agents.orgId, orgId));
  return rows.map(toAgent);
}

export async function getAgent(id: number): Promise<Agent | undefined> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id));
  return row ? toAgent(row) : undefined;
}

export interface NewAgentInput {
  name: string;
  description: string;
  systemPrompt: string;
  mode: AgentMode;
  teamId?: number;
  /** Model catalog id (see @agentfactory/core MODEL_CATALOG). Defaults to DEFAULT_MODEL_ID. */
  model?: string;
}

export async function createAgent(orgId: number, input: NewAgentInput): Promise<Agent> {
  const [row] = await db
    .insert(agents)
    .values({
      orgId,
      teamId: input.teamId ?? null,
      name: capName(input.name),
      description: input.description || null,
      avatarEmoji: "🤖",
      systemPrompt: input.systemPrompt,
      model: buildModelSpec(input.model),
      mode: input.mode,
      runtimeKind: "claude-code",
      toolPolicy: { defaultDecision: "deny", rules: [] },
      skillIds: [],
      connectionIds: [],
    })
    .returning();
  return toAgent(row);
}

export interface AgentPatch
  extends Partial<Pick<Agent, "name" | "description" | "systemPrompt" | "mode" | "teamId" | "areaMap" | "defaultCodebase">> {
  /** Model catalog id (see @agentfactory/core MODEL_CATALOG). */
  model?: string;
}

export async function updateAgent(agentId: number, patch: AgentPatch): Promise<Agent | undefined> {
  const values: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = capName(patch.name);
  if (patch.description !== undefined) values.description = patch.description || null;
  if (patch.systemPrompt !== undefined) values.systemPrompt = patch.systemPrompt;
  if (patch.mode !== undefined) values.mode = patch.mode;
  if ("teamId" in patch) values.teamId = patch.teamId ?? null;
  if ("areaMap" in patch) values.areaMap = patch.areaMap ?? null;
  if (patch.defaultCodebase !== undefined) values.defaultCodebase = patch.defaultCodebase || null;
  if (patch.model !== undefined) values.model = buildModelSpec(patch.model);

  const [row] = await db.update(agents).set(values).where(eq(agents.id, agentId)).returning();
  return row ? toAgent(row) : undefined;
}

export async function deleteAgent(agentId: number): Promise<void> {
  await db.delete(agents).where(eq(agents.id, agentId));
}
