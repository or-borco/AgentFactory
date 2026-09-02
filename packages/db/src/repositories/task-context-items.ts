import { and, count, eq } from "drizzle-orm";
import type { TaskContextItem } from "@agentfactory/core";
import { db } from "../client";
import { runContextRetrievals, taskContextChunks, taskContextItems } from "../schema";

export interface NewTaskContextItem {
  taskId: number;
  orgId: number;
  title: string;
  sizeBytes: number;
  sha256: string;
  mime: string;
  uploadedBy?: number;
}

function toItem(row: typeof taskContextItems.$inferSelect): TaskContextItem {
  return {
    id: row.id,
    taskId: row.taskId,
    orgId: row.orgId,
    title: row.title,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    mime: row.mime,
    source: row.source,
    status: row.status,
    error: row.error ?? undefined,
    indexedAt: row.indexedAt ? row.indexedAt.toISOString() : undefined,
    uploadedBy: row.uploadedBy ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

// undefined rather than a throw: a duplicate upload is a normal user outcome, and the route
// turns it into a 409. Duplicates are rejected, never deduplicated into a second item. Mirrors
// createTeamContextItem.
export async function createTaskContextItem(
  input: NewTaskContextItem,
): Promise<TaskContextItem | undefined> {
  const [row] = await db
    .insert(taskContextItems)
    .values(input)
    .onConflictDoNothing({ target: [taskContextItems.taskId, taskContextItems.sha256] })
    .returning();
  return row ? toItem(row) : undefined;
}

// Org-scoped by the denormalized column, so a caller cannot list another tenant's documents by
// guessing a taskId.
export async function listTaskContextItemsForOrg(
  taskId: number,
  orgId: number,
): Promise<TaskContextItem[]> {
  const rows = await db
    .select()
    .from(taskContextItems)
    .where(and(eq(taskContextItems.taskId, taskId), eq(taskContextItems.orgId, orgId)))
    .orderBy(taskContextItems.createdAt, taskContextItems.id);
  return rows.map(toItem);
}

// Unscoped by id — only the ingest worker calls it, from a job it was handed, never from a
// request parameter.
export async function getTaskContextItem(id: number): Promise<TaskContextItem | undefined> {
  const [row] = await db.select().from(taskContextItems).where(eq(taskContextItems.id, id));
  return row ? toItem(row) : undefined;
}

// Same signature and same guarantee as the team version: one statement against the denormalized
// org_id, never a select-then-delete behind an innerJoin(tasks, …). Mirrors
// deleteTeamContextItemForOrg's run_context_retrievals null-out, scoped to itemKind: "task" so a
// team item sharing this numeric id is never touched.
export async function deleteTaskContextItemForOrg(id: number, orgId: number): Promise<boolean> {
  const rows = await db
    .delete(taskContextItems)
    .where(and(eq(taskContextItems.id, id), eq(taskContextItems.orgId, orgId)))
    .returning({ id: taskContextItems.id });
  if (rows.length === 0) return false;

  await db
    .update(runContextRetrievals)
    .set({ itemId: null })
    .where(and(eq(runContextRetrievals.itemId, id), eq(runContextRetrievals.itemKind, "task")));

  return true;
}

// The three writes the ingest worker makes. Each is a whole-row status assignment rather than a
// conditional update, mirroring markTeamContextItem{Indexing,Indexed,Failed} — the caller has
// already decided the transition is legal, and duplicating that rule here would let them disagree.

export async function markTaskContextItemIndexing(id: number): Promise<void> {
  // error is cleared on the way in, not on the way out: a redelivered job that succeeds must
  // not leave the previous attempt's message sitting under an "Indexed" badge.
  await db
    .update(taskContextItems)
    .set({ status: "indexing", error: null })
    .where(eq(taskContextItems.id, id));
}

export async function markTaskContextItemIndexed(id: number): Promise<void> {
  await db
    .update(taskContextItems)
    .set({ status: "indexed", error: null, indexedAt: new Date() })
    .where(eq(taskContextItems.id, id));
}

export async function markTaskContextItemFailed(id: number, error: string): Promise<void> {
  // indexedAt is deliberately untouched — it means "the moment this item's chunks became
  // current", and a failed attempt did not produce any.
  await db.update(taskContextItems).set({ status: "failed", error }).where(eq(taskContextItems.id, id));
}

// Mirrors countIndexedTeamContextItems: counts task_context_chunks rather than task_context_items
// rows, so a task with an item marked "indexed" but zero produced chunks (an empty or
// whitespace-only document) still reports zero — there would be nothing for
// searchTaskContextChunks to find.
export async function countIndexedTaskContextItems(taskId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(taskContextChunks)
    .where(eq(taskContextChunks.taskId, taskId));
  return row?.value ?? 0;
}
