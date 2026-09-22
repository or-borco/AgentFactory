import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, lt, notExists } from "drizzle-orm";
import type { Session, SessionOrigin } from "@agentfactory/core";
import { db } from "../client";
import { runs, sessions } from "../schema";
import { NON_TERMINAL_RUN_STATUSES } from "./runs";

export function toSession(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    origin: row.origin,
    externalThreadRef: row.externalThreadRef ?? undefined,
    sandboxId: row.sandboxId ?? undefined,
    sandboxImage: row.sandboxImage ?? undefined,
    branchToken: row.branchToken ?? undefined,
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

export async function listSessions(orgId: number, agentId?: number): Promise<Session[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(agentId !== undefined ? and(eq(sessions.orgId, orgId), eq(sessions.agentId, agentId)) : eq(sessions.orgId, orgId));
  return rows.map(toSession);
}

export async function getSession(id: number): Promise<Session | undefined> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  return row ? toSession(row) : undefined;
}

export interface CreateSessionOptions {
  origin?: SessionOrigin;
  externalThreadRef?: string;
}

export async function createSession(
  orgId: number,
  agentId: number,
  title: string,
  opts: CreateSessionOptions = {},
): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({
      orgId,
      agentId,
      title,
      origin: opts.origin ?? "web",
      externalThreadRef: opts.externalThreadRef,
      // See Session.branchToken in @agentfactory/core for why this needs to be unique beyond
      // just this row's own id.
      branchToken: randomBytes(4).toString("hex"),
    })
    .returning();
  return toSession(row);
}

export async function touchSessionActivity(id: number): Promise<void> {
  await db.update(sessions).set({ lastActivityAt: new Date() }).where(eq(sessions.id, id));
}

export async function setSessionSandbox(id: number, sandboxId: string, sandboxImage: string): Promise<void> {
  await db.update(sessions).set({ sandboxId, sandboxImage }).where(eq(sessions.id, id));
}

export async function clearSessionSandbox(id: number): Promise<void> {
  await db.update(sessions).set({ sandboxId: null, sandboxImage: null }).where(eq(sessions.id, id));
}

// Feeds apps/worker's sandboxReapWorker scan: sessions with a warm sandbox that has sat idle
// since before `cutoff` (caller passes now - SANDBOX_IDLE_THRESHOLD_MS) and no run currently in
// flight. The non-terminal-run exclusion here is a courtesy — it keeps the scan from bothering to
// enqueue a teardown job for a session it already knows is mid-run — but it's still a
// read-then-act race against a run starting a moment later, which is why the teardown worker's
// processor (hasNonTerminalRun, runs.ts) re-checks immediately before it actually destroys
// anything. That second check is the one that has to be correct; this one is just triage.
export async function listIdleSandboxSessions(cutoff: Date): Promise<Session[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        isNotNull(sessions.sandboxId),
        lt(sessions.lastActivityAt, cutoff),
        notExists(
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.sessionId, sessions.id), inArray(runs.status, NON_TERMINAL_RUN_STATUSES))),
        ),
      ),
    );
  return rows.map(toSession);
}
