import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../client";
import { channelRedemptionAttempts } from "../schema";

const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 15 * 60 * 1000;

export async function isInCooldown(connectionId: number, externalUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: channelRedemptionAttempts.id })
    .from(channelRedemptionAttempts)
    .where(
      and(
        eq(channelRedemptionAttempts.connectionId, connectionId),
        eq(channelRedemptionAttempts.externalUserId, externalUserId),
        gt(channelRedemptionAttempts.cooldownUntil, sql`now()`),
      ),
    );
  return row !== undefined;
}

// Upsert-increment: the unique index on (connectionId, externalUserId) makes the first failed
// attempt an insert and every subsequent one an update, all in one round trip.
export async function recordFailedRedemption(connectionId: number, externalUserId: string): Promise<void> {
  await db
    .insert(channelRedemptionAttempts)
    .values({ connectionId, externalUserId, failCount: 1, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: [channelRedemptionAttempts.connectionId, channelRedemptionAttempts.externalUserId],
      set: {
        failCount: sql`CASE WHEN ${channelRedemptionAttempts.failCount} + 1 >= ${MAX_ATTEMPTS} THEN 0 ELSE ${channelRedemptionAttempts.failCount} + 1 END`,
        cooldownUntil: sql`CASE WHEN ${channelRedemptionAttempts.failCount} + 1 >= ${MAX_ATTEMPTS} THEN now() + interval '${sql.raw(String(COOLDOWN_MS / 1000))} seconds' ELSE ${channelRedemptionAttempts.cooldownUntil} END`,
        updatedAt: sql`now()`,
      },
    });
}

export async function clearRedemptionAttempts(connectionId: number, externalUserId: string): Promise<void> {
  await db
    .update(channelRedemptionAttempts)
    .set({ failCount: 0, cooldownUntil: null, updatedAt: sql`now()` })
    .where(and(eq(channelRedemptionAttempts.connectionId, connectionId), eq(channelRedemptionAttempts.externalUserId, externalUserId)));
}
