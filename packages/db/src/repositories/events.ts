import { db } from "../client";
import { events } from "../schema";

export async function createEvent(
  runId: number,
  seq: number,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({ runId, seq, type, data });
}
