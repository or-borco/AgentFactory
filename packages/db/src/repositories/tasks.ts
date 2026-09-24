import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Session, SessionOrigin, Task, TaskExternalRef, TaskStatus } from "@agentfactory/core";
import { db } from "../client";
import { messages, sessions, tasks } from "../schema";
import { toSession } from "./sessions";

export function toTask(row: typeof tasks.$inferSelect): Task {
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
    area: row.area,
    codebase: row.codebase,
    model: row.model ?? undefined,
    prNumber: row.prNumber ?? undefined,
    prUrl: row.prUrl ?? undefined,
    externalRef: row.externalRef ?? undefined,
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
  /** Overrides the assignee agent's default model for this task. */
  model?: Task["model"];
  externalRef?: TaskExternalRef;
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
      model: input.model,
      externalRef: input.externalRef,
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
  area?: string | null;
  codebase?: string | null;
  model?: Task["model"] | null;
  prNumber?: number;
  prUrl?: string;
  externalRef?: TaskExternalRef | null;
}

export async function updateTask(id: number, patch: UpdateTaskInput): Promise<Task> {
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return toTask(row);
}

export async function deleteTask(id: number): Promise<void> {
  await db.delete(tasks).where(eq(tasks.id, id));
}

export interface StartTaskSessionOptions {
  origin: SessionOrigin;
  externalThreadRef?: string;
}

export type StartTaskSessionResult =
  | { started: true; session: Session; userMessageId: number; task: Task }
  | { started: false; task: Task };

// The single atomic "start this task" primitive, shared by the web run route and the Telegram
// webhook route — see the Telegram task-integration design spec's "Data model" section for the
// full rationale. The SELECT ... FOR UPDATE row lock means a concurrent second caller blocks and,
// once unblocked, sees sessionId already set and creates nothing: no orphan session, no orphan
// message. This is the third transaction in this repo (the others are searchTeamContextChunks in
// context-chunks.ts and the one in task-context-chunks.ts).
export async function startTaskSession(
  taskId: number,
  orgId: number,
  agentId: number,
  title: string,
  briefText: string,
  sessionOpts: StartTaskSessionOptions,
): Promise<StartTaskSessionResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    // No task-deletion UI exists today, so this is unreachable in practice — an explicit error
    // beats an opaque crash a few lines down if that ever changes.
    if (!row) throw new Error(`Task ${taskId} not found`);
    if (row.orgId !== orgId) throw new Error(`Task ${taskId} does not belong to org ${orgId}`);
    if (row.sessionId) return { started: false, task: toTask(row) };

    const [sessionRow] = await tx
      .insert(sessions)
      .values({
        orgId,
        agentId,
        title,
        origin: sessionOpts.origin,
        externalThreadRef: sessionOpts.externalThreadRef,
        branchToken: randomBytes(4).toString("hex"),
      })
      .returning();

    const [messageRow] = await tx
      .insert(messages)
      .values({ sessionId: sessionRow.id, role: "user", content: briefText, kind: "task_brief" })
      .returning();

    const [updatedRow] = await tx
      .update(tasks)
      // updatedAt has no $onUpdate in the schema — updateTask() (below) sets it explicitly on
      // every write, and this raw tx.update must match that or the task silently stops advancing
      // in any updatedAt-ordered view (the Telegram main menu's own sort, the web Activity feed).
      .set({ assigneeAgentId: agentId, sessionId: sessionRow.id, status: "in_progress", updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning();

    return { started: true, session: toSession(sessionRow), userMessageId: messageRow.id, task: toTask(updatedRow) };
  });
}
