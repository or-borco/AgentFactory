// Tenant-isolation: task.orgId !== ctx.orgId is treated as 404, not 403 — same reasoning as
// apps/web/src/app/api/tasks/[taskId]/context-items/route.ts (a task in another org must not be
// distinguishable from one that isn't there).
import { NextResponse } from "next/server";
import type { ExternalIssue, ExternalAttachment } from "@agentfactory/integrations";
import type { Task } from "@agentfactory/core";
import { createTaskContextItem, getTask, insertContentBlob, updateTask } from "@agentfactory/db";
import { enqueueTaskContextIngestJob } from "@agentfactory/queue";
import { createBlobStore } from "@agentfactory/storage";
import { requireAuthContext } from "@/server/auth";
import { resolveTaskProvider } from "@/server/task-provider";
import { checkTaskSync } from "@/server/task-sync";
import { MAX_UPLOAD_BYTES } from "@/app/api/tasks/[taskId]/context-items/route";

// Applies a freshly-fetched issue onto its task: the same "persist link + ingest attachments"
// sequence POST /api/tasks runs at task-creation time (apps/web/src/app/api/tasks/route.ts) —
// see that file's comments for the full reasoning. Kept as a private helper here rather than a
// new shared file: this route is the only other caller.
async function applyLatestIssue(orgId: number, task: Task, latest: ExternalIssue): Promise<void> {
  await updateTask(task.id, {
    title: latest.title,
    description: latest.description,
    externalRef: task.externalRef && { ...task.externalRef, lastKnownUpdated: latest.updated },
  });

  if (latest.attachments.length === 0) return;

  // Already a no-op for anything ingested before: createTaskContextItem returns undefined on a
  // duplicate (taskId, sha256) instead of erroring, so a previously-fetched attachment is never
  // re-downloaded into a second row. Wrapped so a broken attachment fetch never turns a
  // successful sync into a failed one.
  try {
    const resolved = await resolveTaskProvider(orgId);
    if (!resolved) return;
    const blobStore = createBlobStore();
    for (const attachment of latest.attachments as ExternalAttachment[]) {
      if (attachment.sizeBytes > MAX_UPLOAD_BYTES) continue; // skip oversized, don't drop the rest
      const bytes = await resolved.provider.fetchAttachment(attachment);
      const { sha256, sizeBytes } = await blobStore.put(orgId, bytes, attachment.mime);
      await insertContentBlob(orgId, sha256, sizeBytes, attachment.mime);
      const item = await createTaskContextItem({
        taskId: task.id,
        orgId,
        title: attachment.filename,
        sizeBytes,
        sha256,
        mime: attachment.mime,
        source: "jira",
      });
      if (item) await enqueueTaskContextIngestJob(item.id);
    }
  } catch (err) {
    console.error(`Failed to ingest issue attachments while syncing task ${task.id}:`, err);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task || task.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // No body is a valid request (a plain Refresh click) — don't let an empty payload 500 the route.
  const body = await request.json().catch(() => ({}));

  const result = await checkTaskSync(ctx.orgId, task);
  if (!result.stale) {
    return NextResponse.json({ stale: false });
  }

  if (body.apply !== true) {
    // No apply: the caller renders a diff before deciding what to do.
    return NextResponse.json({ stale: true, latest: result.latest });
  }

  await applyLatestIssue(ctx.orgId, task, result.latest);
  return NextResponse.json({ stale: false, applied: true });
}
