import type { Task } from "@agentfactory/core";
import { getConnectionCredentialRef, listConnections, readConnectionSecret, setConnectionHealth, updateTask } from "@agentfactory/db";
import { createTaskProvider, ProviderError } from "@agentfactory/integrations";

// Resolves the org's connection/secret/provider the same way apps/web/src/server/task-provider.ts's
// resolveTaskProvider does. Duplicated rather than imported — apps/worker and apps/web are separate
// processes/packages with no shared-code path between them today, and this is ~15 lines. This is
// the same established tradeoff as apps/worker/src/scm-provider.ts's signAppJwt duplication.
// Revisit if a third consumer needs it.
async function resolveTaskProvider(orgId: number) {
  const connection = (await listConnections(orgId)).find((c) => c.kind === "tasks");
  if (!connection) return undefined;

  try {
    const credentialRef = await getConnectionCredentialRef(orgId, connection.id);
    if (credentialRef == null) return undefined;

    const secret = await readConnectionSecret(orgId, credentialRef);
    if (!secret) return undefined;

    return { connection, provider: createTaskProvider(connection, secret) };
  } catch (err) {
    console.error(`Failed to resolve task provider for connection ${connection.id}:`, err);
    return undefined;
  }
}

// Comments on the linked Jira issue when a run opens a PR for its task — the entire write-back
// surface (Product decision 3: no status transition, ever, not even opt-in). Wrapped so nothing it
// does can throw into the run: a Jira comment is a courtesy, not part of the deliverable, and the
// run must still report pr_open regardless of what Jira does. Mirrors how skills-materialize.ts
// degrades (returns [] and logs rather than throwing).
export async function notifyIssueOfPullRequest(
  orgId: number,
  task: Task,
  pr: { number: number; url: string },
  emitEvent: (type: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const externalRef = task.externalRef;
  if (!externalRef) return;

  let connectionId: number | undefined;
  try {
    const resolved = await resolveTaskProvider(orgId);
    if (!resolved) return;
    const { connection, provider } = resolved;
    connectionId = connection.id;

    const writeBack = connection.config.writeBack as { comment?: boolean } | undefined;
    if (writeBack?.comment !== false) {
      const body = `AgentFactory opened a pull request for ${task.ref} (${task.title}): ${pr.url}`;
      await provider.addComment(externalRef.key, body);
    }

    // A task whose earlier write-back failed and is somehow retried in the future (not possible
    // yet - write-back fires at most once per task today) should not keep showing a stale failure
    // once a write-back actually succeeds.
    if (externalRef.writeBackFailure) {
      await updateTask(task.id, { externalRef: { ...externalRef, writeBackFailure: undefined } });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Recorded as a run event (not just console.error) so this is visible in the transcript -
    // this failure previously vanished silently, leaving no trace that the Jira issue was never
    // notified about the PR.
    await emitEvent("error", {
      message: `Couldn't comment on Jira issue ${externalRef.key}: ${message}`,
    });

    await updateTask(task.id, {
      externalRef: { ...externalRef, writeBackFailure: { message, occurredAt: new Date().toISOString() } },
    });

    if (err instanceof ProviderError && connectionId !== undefined) {
      await setConnectionHealth(orgId, connectionId, err.isAuthFailure ? "expired" : "needs-attention");
    }
  }
}
