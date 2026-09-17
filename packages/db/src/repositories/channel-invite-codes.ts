import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../client";
import { channelInviteCodes } from "../schema";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Crockford base32 (no 0/O/1/I) so a spoken-aloud or misread code doesn't collide with a
// visually-similar character.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

const CODE_SHAPE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`, "i");

/**
 * Whether a string could plausibly be a code this module mints. Callers use it to tell "the user
 * is trying a code" apart from "the user is just talking", so that ordinary chatter never burns a
 * failed-redemption attempt against the cooldown. Case-insensitive because a human retyping a
 * code by hand may not match the minted casing — that's a redemption miss, not a non-attempt.
 */
export function looksLikeInviteCode(candidate: string): boolean {
  return CODE_SHAPE.test(candidate);
}

export interface InviteCode {
  id: number;
  orgId: number;
  connectionId: number;
  code: string;
  createdBy: number;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  redeemedByExternalUserId?: string;
}

function toInviteCode(row: typeof channelInviteCodes.$inferSelect): InviteCode {
  return {
    id: row.id,
    orgId: row.orgId,
    connectionId: row.connectionId,
    code: row.code,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    redeemedAt: row.redeemedAt?.toISOString(),
    redeemedByExternalUserId: row.redeemedByExternalUserId ?? undefined,
  };
}

export async function generateInviteCode(
  orgId: number,
  connectionId: number,
  createdBy: number,
  expiresInMs: number = SEVEN_DAYS_MS,
): Promise<InviteCode> {
  // Collision retry: astronomically unlikely at 8 chars from a 32-symbol alphabet (32^8 ≈ 1.1e12
  // combinations), but the unique constraint makes a collision a clean retry rather than a corrupt
  // insert either way.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(channelInviteCodes)
        .values({
          orgId,
          connectionId,
          code: generateCode(),
          createdBy,
          expiresAt: new Date(Date.now() + expiresInMs),
        })
        .returning();
      return toInviteCode(row);
    } catch (err) {
      const isUniqueViolation = err instanceof Error && "code" in err && (err as { code?: string }).code === "23505";
      if (!isUniqueViolation || attempt === 4) throw err;
    }
  }
  throw new Error("unreachable");
}

// The single atomic operation that makes "single-use" race-safe: two concurrent callers racing on
// the same code can both run this UPDATE, but only one row satisfies `redeemedAt IS NULL AND
// expiresAt > now()` by the time either commits, so at most one RETURNING row comes back.
export async function redeemInviteCode(code: string, externalUserId: string): Promise<InviteCode | undefined> {
  const [row] = await db
    .update(channelInviteCodes)
    .set({ redeemedAt: sql`now()`, redeemedByExternalUserId: externalUserId })
    .where(and(eq(channelInviteCodes.code, code), isNull(channelInviteCodes.redeemedAt), gt(channelInviteCodes.expiresAt, sql`now()`)))
    .returning();
  return row ? toInviteCode(row) : undefined;
}

// Looks up which admin's invite code this chat most recently redeemed on this connection — used
// only as the createdBy attribution for a task the chat creates via Telegram (Task.createdBy is
// NOT NULL and has no natural Telegram-side user account to point at instead). Ordered by
// redeemedAt so a chat that was revoked and re-invited under a different admin's code attributes
// to whichever redemption actually authorized it most recently, not the first one ever.
export async function getInviteCodeRedeemer(
  connectionId: number,
  externalUserId: string,
): Promise<{ createdBy: number } | undefined> {
  const [row] = await db
    .select({ createdBy: channelInviteCodes.createdBy })
    .from(channelInviteCodes)
    .where(and(eq(channelInviteCodes.connectionId, connectionId), eq(channelInviteCodes.redeemedByExternalUserId, externalUserId)))
    .orderBy(desc(channelInviteCodes.redeemedAt))
    .limit(1);
  return row;
}

export async function listInviteCodes(connectionId: number): Promise<InviteCode[]> {
  const rows = await db.select().from(channelInviteCodes).where(eq(channelInviteCodes.connectionId, connectionId));
  return rows.map(toInviteCode);
}

export async function revokeInviteCode(connectionId: number, id: number): Promise<void> {
  await db
    .update(channelInviteCodes)
    .set({ expiresAt: sql`now()` })
    .where(and(eq(channelInviteCodes.connectionId, connectionId), eq(channelInviteCodes.id, id)));
}
