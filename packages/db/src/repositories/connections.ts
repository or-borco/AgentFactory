import { and, eq } from "drizzle-orm";
import type {
  Connection,
  ConnectionAuthKind,
  ConnectionHealth,
  ConnectionKind,
  ConnectionProvider,
} from "@agentfactory/core";
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
    auth: row.auth,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listConnections(orgId: number): Promise<Connection[]> {
  const rows = await db.select().from(connections).where(eq(connections.orgId, orgId));
  return rows.map(toConnection);
}

export async function getConnection(orgId: number, id: number): Promise<Connection | undefined> {
  const [row] = await db.select().from(connections).where(and(eq(connections.orgId, orgId), eq(connections.id, id)));
  return row ? toConnection(row) : undefined;
}
export interface NewConnectionInput {
  provider: ConnectionProvider;
  kind: ConnectionKind;
  label: string;
  config: Record<string, unknown>;
  // Both optional. `auth` defaults to "none" at the DB level (connections.auth has a NOT NULL
  // DEFAULT 'none'), so omitting it here is correct for the GitHub case; callers that do need a
  // credential (e.g. connecting Jira) pass both together once the secret has already been written.
  auth?: ConnectionAuthKind;
  credentialRef?: number | null;
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
      ...(input.auth !== undefined ? { auth: input.auth } : {}),
      ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
    })
    .returning();
  return toConnection(row);
}

export async function deleteConnection(id: number): Promise<void> {
  await db.delete(connections).where(eq(connections.id, id));
}

export interface ConnectionPatch {
  label?: string;
  config?: Record<string, unknown>;
  health?: ConnectionHealth;
  credentialRef?: number | null;
}

export async function updateConnection(
  orgId: number,
  id: number,
  patch: ConnectionPatch,
): Promise<Connection | undefined> {
  const [row] = await db
    .update(connections)
    .set(patch)
    .where(and(eq(connections.orgId, orgId), eq(connections.id, id)))
    .returning();
  return row ? toConnection(row) : undefined;
}

/** Called from the credential paths: 401 -> "expired", any other provider failure -> "needs-attention". */
export async function setConnectionHealth(orgId: number, id: number, health: ConnectionHealth): Promise<void> {
  await db
    .update(connections)
    .set({ health })
    .where(and(eq(connections.orgId, orgId), eq(connections.id, id)));
}

/**
 * Internal accessor for the encrypted-credential reference, org-scoped. Deliberately separate
 * from `Connection`/`toConnection` — GET /api/connections returns `Connection` verbatim to the
 * browser, so `credentialRef` must never be assembled onto that public shape. Used only by
 * server-side resolvers that turn around and call `readConnectionSecret(orgId, credentialRef)`
 * (e.g. apps/web/src/server/task-provider.ts's `resolveTaskProvider`). Returns `undefined` for a
 * missing or wrong-org row, `null` when the row exists but has no credential set.
 */
export async function getConnectionCredentialRef(orgId: number, id: number): Promise<number | null | undefined> {
  const [row] = await db
    .select({ credentialRef: connections.credentialRef })
    .from(connections)
    .where(and(eq(connections.orgId, orgId), eq(connections.id, id)));
  return row?.credentialRef;
}
