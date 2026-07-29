import { eq } from "drizzle-orm";
import type { ChatMessage } from "@agentfactory/core";
import { db } from "../client";
import { messages } from "../schema";

function toChatMessage(row: typeof messages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMessages(sessionId: number): Promise<ChatMessage[]> {
  const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
  return rows.map(toChatMessage);
}

export async function createMessage(
  sessionId: number,
  role: "user" | "assistant",
  content: string,
): Promise<ChatMessage> {
  const [row] = await db
    .insert(messages)
    .values({
      sessionId,
      role,
      content,
    })
    .returning();
  return toChatMessage(row);
}
