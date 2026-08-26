import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import type { User } from "@agentfactory/core";
import { createAuthSession, deleteAuthSession, getPrimaryMembership, getUserByTokenHash } from "@agentfactory/db";

const COOKIE_NAME = "af_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Only the hash is ever persisted (see schema.ts authSessions) — this mirrors that on the read
// side, so the raw cookie value never touches the DB.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: number): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await createAuthSession({ tokenHash: hashToken(token), userId, expiresAt });

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

// Wrapped in React's cache() so the root layout (which needs the user's theme preference to set
// data-theme on <html>) and (app)/layout.tsx (which needs it for the auth redirect) share one DB
// lookup per request instead of two — cache() dedupes by arguments for the lifetime of a single
// render pass, then resets on the next request.
export const getCurrentUser = cache(async (): Promise<User | undefined> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return undefined;
  return getUserByTokenHash(hashToken(token));
});

export interface AuthContext {
  user: User;
  orgId: number;
}

// The orgId every API route needs, resolved from the session instead of a hardcoded constant.
// A user with no membership (shouldn't happen post-register, but the DB doesn't enforce it) is
// treated as unauthenticated rather than crashing the route.
export async function requireAuthContext(): Promise<AuthContext | undefined> {
  const user = await getCurrentUser();
  if (!user) return undefined;
  const membership = await getPrimaryMembership(user.id);
  if (!membership) return undefined;
  return { user, orgId: membership.orgId };
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token) await deleteAuthSession(hashToken(token));
  cookieStore.delete(COOKIE_NAME);
}
