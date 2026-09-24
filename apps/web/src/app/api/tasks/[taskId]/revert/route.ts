import { NextResponse } from "next/server";
import { getTask, revertTaskFromDone } from "@agentfactory/db";
import { resolveScmConnection } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("api:tasks:[taskId]:revert");

// Undoes an accidental (or premature) "done" — e.g. a follow-up task was filed after the fact.
// If the task's PR was actually merged, the branch it lived on is spent, so the task loses its
// session here and the next run starts a fresh one. If the PR is still open (or none was ever
// opened), the existing session/branch is left in place so the agent can just keep adding to it.
export async function POST(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (task.status !== "done") {
    return NextResponse.json({ error: `Task is ${task.status}, not done` }, { status: 409 });
  }

  let merged = false;
  if (task.prNumber && task.codebase) {
    const resolved = await resolveScmConnection(ctx.orgId, task.codebase);
    if (resolved) {
      try {
        const pr = await resolved.provider.fetchPullRequest(resolved.connection, task.codebase, task.prNumber);
        merged = pr.state === "merged";
      } catch (err) {
        log.error("Failed to fetch PR state while reverting task from done", { taskId: task.id, err });
      }
    }
  }

  const updated = await revertTaskFromDone(task.id, ctx.orgId, { clearSession: merged });
  if (!updated) {
    return NextResponse.json({ error: "Task is no longer done" }, { status: 409 });
  }

  return NextResponse.json(updated);
}
