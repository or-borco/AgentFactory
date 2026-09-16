import type { Task } from "@agentfactory/core";
import type { ExternalIssue } from "@agentfactory/integrations";
import { createLogger } from "@agentfactory/logger";
import { resolveTaskProvider } from "./task-provider";

const log = createLogger("task-sync");

export type TaskSyncResult = { stale: false } | { stale: true; latest: ExternalIssue };

// A staleness check is a read, triggered by a user (Refresh, or the instant Run is clicked), and
// it must never be why a run couldn't happen — see Design decision 12 in
// AgentFactoryContext/superpowers/specs/2026-09-12-jira-integration-design.md. Provider errors, a missing
// connection, a deleted issue, and an unset externalRef all resolve to "not stale"; only a
// successful fetch that shows real drift returns `stale: true`. The whole body is wrapped so
// this function itself can never throw — a Jira outage must read as "nothing to worry about,"
// never as "block everything downstream."
export async function checkTaskSync(orgId: number, task: Task): Promise<TaskSyncResult> {
  if (!task.externalRef) return { stale: false };

  try {
    const resolved = await resolveTaskProvider(orgId);
    if (!resolved) return { stale: false };

    const latest = await resolved.provider.fetchIssue(task.externalRef.key);
    if (!latest) return { stale: false }; // issue deleted upstream — nothing to compare against

    if (latest.updated === task.externalRef.lastKnownUpdated) return { stale: false };
    return { stale: true, latest };
  } catch (err) {
    log.error("checkTaskSync failed, failing open", { taskId: task.id, err });
    return { stale: false };
  }
}
