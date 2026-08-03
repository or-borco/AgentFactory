import { eq } from "drizzle-orm";
import type { Task, TaskStatus } from "@agentfactory/core";
import { db } from "../client";
import { tasks } from "../schema";

function toTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    orgId: row.orgId,
    ref: row.ref,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria as Task["acceptanceCriteria"],
    status: row.status as TaskStatus,
    assigneeAgentId: row.assigneeAgentId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    area: row.area ?? undefined,
    codebase: row.codebase ?? undefined,
    prNumber: row.prNumber ?? undefined,
    prUrl: row.prUrl ?? undefined,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listTasks(orgId: number): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.orgId, orgId))
    .orderBy(tasks.id);
  return rows.map(toTask).reverse(); // newest first
}

export async function getTask(id: number): Promise<Task | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row ? toTask(row) : undefined;
}

// The FK points tasks -> sessions (a task owns 0..1 sessions), so finding "the task for this
// session" is a reverse lookup — needed by the worker to resolve a run's target repo.
export async function getTaskBySessionId(sessionId: number): Promise<Task | undefined> {
  const [row] = await db.select().from(tasks).where(eq(tasks.sessionId, sessionId));
  return row ? toTask(row) : undefined;
}

export interface NewTaskInput {
  title: string;
  description: string;
  acceptanceCriteria: Task["acceptanceCriteria"];
  assigneeAgentId?: number;
  area?: string;
  codebase?: string;
}

export async function createTask(
  orgId: number,
  createdBy: number,
  input: NewTaskInput,
): Promise<Task> {
  // Insert first to get the auto-generated id, then patch ref = "T-<id>".
  const [row] = await db
    .insert(tasks)
    .values({
      orgId,
      createdBy,
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      status: input.assigneeAgentId ? "assigned" : "open",
      assigneeAgentId: input.assigneeAgentId,
      area: input.area,
      codebase: input.codebase,
    })
    .returning();

  // Patch the ref now that we have the id.
  const ref = `T-${String(row.id).padStart(3, "0")}`;
  const [updated] = await db
    .update(tasks)
    .set({ ref })
    .where(eq(tasks.id, row.id))
    .returning();
  return toTask(updated);
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  acceptanceCriteria?: Task["acceptanceCriteria"];
  status?: TaskStatus;
  assigneeAgentId?: number | null;
  sessionId?: number | null;
  area?: string;
  codebase?: string;
  prNumber?: number;
  prUrl?: string;
}

export async function updateTask(id: number, patch: UpdateTaskInput): Promise<Task> {
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return toTask(row);
}

/** Attach a session to a task and flip status to in_progress. */
export async function attachTaskSession(taskId: number, sessionId: number): Promise<Task> {
  return updateTask(taskId, { sessionId, status: "in_progress" });
}
