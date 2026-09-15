// Tenant-isolation gap: requireAuthContext() checks that the caller is logged in and resolves
// their orgId, but does not yet verify resource-level ownership (same documented gap as
// /api/runs/[runId] and /api/sessions/[sessionId]/messages).
import { NextResponse } from "next/server";
import { createTask, createTaskContextItem, insertContentBlob, listTasks } from "@agentfactory/db";
import { enqueueRepoMapWarmJob, enqueueTaskContextIngestJob } from "@agentfactory/queue";
import { isValidModelId } from "@agentfactory/core";
import type { ExternalAttachment } from "@agentfactory/integrations";
import { createBlobStore } from "@agentfactory/storage";
import { requireAuthContext } from "@/server/auth";
import { resolveTaskProvider } from "@/server/task-provider";
import { MAX_UPLOAD_BYTES } from "@/app/api/tasks/[taskId]/context-items/route";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("api:tasks");

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listTasks(ctx.orgId));
}

export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  if (body.model !== undefined && !isValidModelId(body.model?.id)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  const task = await createTask(ctx.orgId, ctx.user.id, {
    title: body.title,
    description: body.description ?? "",
    acceptanceCriteria: body.acceptanceCriteria ?? [],
    assigneeAgentId: body.assigneeAgentId ?? undefined,
    area: body.area ?? undefined,
    codebase: body.codebase ?? undefined,
    model: body.model ?? undefined,
    externalRef: body.externalRef ?? undefined,
  });

  // Creating a task with a codebase is the most common way a repository first becomes relevant,
  // and it was the one entry point that did not warm the map — PATCH /api/tasks/[taskId] and all
  // four agent/team routes already do this. On task T-070 the map for the task's codebase was
  // generated 54 seconds into an 8-minute run and never read, because nothing scheduled it until
  // the run itself missed the cache.
  //
  // Fire-and-forget with the same .catch as the other call sites: a queue outage must not turn a
  // successful task creation into a 500, and a missed warm only means the next run pays the
  // generation cost, exactly as it does today.
  if (task.codebase) {
    enqueueRepoMapWarmJob(task.orgId, task.codebase).catch((err) => {
      log.error("Failed to enqueue repo map warm job", { taskId: task.id, err });
    });
  }

  // Ingest the linked issue's attachments — same request, same route, because there is no task
  // id to attach documents to before this point (see the Jira integration plan's Task 5, Step 4).
  // The client already fetched ExternalIssue.attachments when it called Fetch on the From-issue
  // field (tasks/new/page.tsx) and sends that list along here; downloading the actual bytes still
  // has to happen server-side, since that needs the org's decrypted tasks-provider credential,
  // which never reaches the browser. This is the exact sequence
  // apps/web/src/app/api/tasks/[taskId]/context-items/route.ts's POST handler runs for a manual
  // upload. Wrapped so a broken attachment fetch never fails the task creation itself — the task
  // and its externalRef must exist either way.
  if (task.externalRef && Array.isArray(body.attachments) && body.attachments.length > 0) {
    try {
      const resolved = await resolveTaskProvider(ctx.orgId);
      if (resolved) {
        const blobStore = createBlobStore();
        for (const attachment of body.attachments as ExternalAttachment[]) {
          if (attachment.sizeBytes > MAX_UPLOAD_BYTES) continue; // skip oversized, don't drop the rest
          const bytes = await resolved.provider.fetchAttachment(attachment);
          const { sha256, sizeBytes } = await blobStore.put(ctx.orgId, bytes, attachment.mime);
          await insertContentBlob(ctx.orgId, sha256, sizeBytes, attachment.mime);
          const item = await createTaskContextItem({
            taskId: task.id,
            orgId: ctx.orgId,
            title: attachment.filename,
            sizeBytes,
            sha256,
            mime: attachment.mime,
            source: "jira",
          });
          // undefined on a duplicate (taskId, sha256) — a silent no-op, not an error. Can't
          // happen on a fresh task today, but the same loop is reused by the refresh flow later.
          if (item) await enqueueTaskContextIngestJob(item.id);
        }
      }
    } catch (err) {
      log.error("Failed to ingest issue attachments for task", { taskId: task.id, err });
    }
  }

  return NextResponse.json(task, { status: 201 });
}
