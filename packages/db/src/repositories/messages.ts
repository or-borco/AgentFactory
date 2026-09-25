import { and, asc, desc, eq } from "drizzle-orm";
import type { ChatMessage } from "@agentfactory/core";
import { db } from "../client";
import { messages } from "../schema";

function toChatMessage(row: typeof messages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    runId: row.runId ?? undefined,
    ...(row.kind === "task_brief" ? { kind: "task_brief" as const } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

// Chronological (oldest first) — callers rely on this for display order and for reconstructing
// conversation history, not just for showing rows in *some* order. `id`, not `createdAt`: an
// auto-increment column can't collide at the same millisecond the way two inserts in the same
// transaction tick could.
export async function listMessages(sessionId: number): Promise<ChatMessage[]> {
  const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.id));
  return rows.map(toChatMessage);
}

export async function getMessage(id: number): Promise<ChatMessage | undefined> {
  const [row] = await db.select().from(messages).where(eq(messages.id, id));
  return row ? toChatMessage(row) : undefined;
}

export async function createMessage(
  sessionId: number,
  role: "user" | "assistant",
  content: string,
  runId?: number,
): Promise<ChatMessage> {
  const [row] = await db
    .insert(messages)
    .values({
      sessionId,
      role,
      content,
      runId,
    })
    .returning();
  return toChatMessage(row);
}

// The eval artefact for a run that committed nothing: the final assistant message the run
// produced. Newest-by-id because a run appends exactly one assistant message today, but
// nothing enforces that — if a future runtime emits several, the last word is the deliverable.
export async function getFinalAssistantMessageForRun(runId: number): Promise<ChatMessage | undefined> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.runId, runId), eq(messages.role, "assistant")))
    .orderBy(desc(messages.id))
    .limit(1);
  return row ? toChatMessage(row) : undefined;
}
