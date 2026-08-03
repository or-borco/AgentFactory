import { eq } from "drizzle-orm";
import type { Connection, ConnectionKind, ConnectionProvider } from "@agentfactory/core";
import { db } from "../client";
import { connections } from "../schema";

function toConnection(row: typeof connections.$inferSelect): Connection {
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider as ConnectionProvider,
    kind: row.kind,
    label: row.label,
    health: row.health,
    config: row.config,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listConnections(orgId: number): Promise<Connection[]> {
  const rows = await db.select().from(connections).where(eq(connections.orgId, orgId));
  return rows.map(toConnection);
}

export async function getConnection(id: number): Promise<Connection | undefined> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id));
  return row ? toConnection(row) : undefined;
}

export interface NewConnectionInput {
  provider: ConnectionProvider;
  kind: ConnectionKind;
  label: string;
  config: Record<string, unknown>;
}

export async function createConnection(orgId: number, input: NewConnectionInput): Promise<Connection> {
  const [row] = await db
    .insert(connections)
    .values({
      orgId,
      provider: input.provider,
      kind: input.kind,
      label: input.label,
      config: input.config,
    })
    .returning();
  return toConnection(row);
}

export async function deleteConnection(id: number): Promise<void> {
  await db.delete(connections).where(eq(connections.id, id));
}
