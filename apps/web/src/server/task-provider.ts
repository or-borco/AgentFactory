import type { Connection } from "@agentfactory/core";
import { getConnectionCredentialRef, listConnections, readConnectionSecret } from "@agentfactory/db";
import { createTaskProvider, type TaskProvider } from "@agentfactory/integrations";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("task-provider");

// Resolves the org's one `tasks`-kind connection (whichever provider it is) and builds the
// TaskProvider adapter for it. "First tasks connection" is safe to treat as *the* connection, not
// merely an arbitrary one, because POST /api/connections/jira's 409 check makes a second one
// unreachable — see Design decision 15 in
// docs/superpowers/specs/2026-09-12-jira-integration-design.md.
//
// Returns undefined rather than throwing whenever the org has no usable connection: no tasks
// connection at all, no credential stored against it, or a credential that fails to decrypt /
// resolve into a known provider. This mirrors findInstallationForRepo's per-connection
// .catch(() => ...) in apps/worker/src/scm-provider.ts — a broken credential path degrades to "no
// usable connection" for the caller, not a crash.
export async function resolveTaskProvider(
  orgId: number,
): Promise<{ connection: Connection; provider: TaskProvider } | undefined> {
  const connection = (await listConnections(orgId)).find((c) => c.kind === "tasks");
  if (!connection) return undefined;

  try {
    const credentialRef = await getConnectionCredentialRef(orgId, connection.id);
    if (credentialRef == null) return undefined;

    const secret = await readConnectionSecret(orgId, credentialRef);
    if (!secret) return undefined;

    return { connection, provider: createTaskProvider(connection, secret) };
  } catch (err) {
    log.error("Failed to resolve task provider", { connectionId: connection.id, err });
    return undefined;
  }
}
