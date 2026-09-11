import { NextResponse } from "next/server";
import {
  createTaskContextItem,
  getTask,
  insertContentBlob,
  listTaskContextItemsForOrg,
} from "@agentfactory/db";
import { enqueueTaskContextIngestJob } from "@agentfactory/queue";
import { createBlobStore } from "@agentfactory/storage";
import { isTaskContextMimeAllowed, taskContextExtensionMime } from "@agentfactory/core";
import { requireAuthContext } from "@/server/auth";

// Mirrors apps/web/src/app/api/teams/[teamId]/context-items/route.ts exactly — see that file's
// comments for the reasoning behind each of these. Kept as literal duplicates rather than a
// shared helper: the two routes' only difference is which scope (team vs task) they resolve and
// which repository/queue function they call, and the team route predates this one (per the
// design's "parallel tables, not a unified schema" decision) — factoring out the shared body now
// would touch a shipped, tested file for a change with no other motivating reason.
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

let blobStore: ReturnType<typeof createBlobStore> | undefined;
function getBlobStore() {
  if (!blobStore) blobStore = createBlobStore();
  return blobStore;
}

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  // 404, not 403: a task in another org must not be distinguishable from one that isn't there.
  if (!task || task.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json(await listTaskContextItemsForOrg(task.id, ctx.orgId));
}

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const task = await getTask(Number(taskId));
  if (!task || task.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File is too large" }, { status: 413 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }
  let mime = file.type;
  if (!isTaskContextMimeAllowed(mime)) {
    const fallback = taskContextExtensionMime(file.name);
    if (!fallback) {
      return NextResponse.json(
        { error: "Only Markdown, plain text, JPEG, and PNG files are supported" },
        { status: 415 },
      );
    }
    mime = fallback;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "File is too large" }, { status: 413 });
  }
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }

  const { sha256, sizeBytes } = await getBlobStore().put(ctx.orgId, bytes, mime);
  await insertContentBlob(ctx.orgId, sha256, sizeBytes, mime);

  const submittedTitle = form.get("title");
  const title = typeof submittedTitle === "string" && submittedTitle.trim() ? submittedTitle.trim() : file.name;

  const item = await createTaskContextItem({
    taskId: task.id,
    orgId: ctx.orgId,
    title,
    sizeBytes,
    sha256,
    mime,
    uploadedBy: ctx.user.id,
  });
  if (!item) {
    return NextResponse.json(
      { error: "This document has already been uploaded to this task" },
      { status: 409 },
    );
  }
  // See enqueueTeamContextIngestJob's comment for why the response doesn't wait on ingestion.
  // No processor consumes TASK_CONTEXT_INGEST_QUEUE_NAME yet (added in PR4) — the item comes
  // back at "pending" and stays there until then.
  await enqueueTaskContextIngestJob(item.id);
  return NextResponse.json(item, { status: 201 });
}
