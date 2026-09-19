import type { Session } from "@agentfactory/core";
import { getConnectionCredentialRef, getTaskBySessionId, listConnections, readConnectionSecret, setConnectionHealth } from "@agentfactory/db";
import { createChannelAdapter } from "@agentfactory/integrations";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("channel-notify");
const TYPING_REFRESH_MS = 4_000;

// Mirrors task-notify.ts's resolveTaskProvider exactly, for the same reason (apps/worker and
// apps/web are separate processes with no shared-code path). Resolves the org's Telegram
// connection for the given agent (when provided), or the first matching connection as a fallback.
async function resolveChannelAdapter(orgId: number, agentId?: number | null) {
  const connection = (await listConnections(orgId)).find(
    (c) => c.kind === "channel" && c.provider === "telegram" && (agentId != null ? c.agentId === agentId : true),
  );
  if (!connection) return undefined;
  try {
    const credentialRef = await getConnectionCredentialRef(orgId, connection.id);
    if (credentialRef == null) return undefined;
    const secret = await readConnectionSecret(orgId, credentialRef);
    if (!secret) return undefined;
    return { connection, adapter: createChannelAdapter(connection, secret) };
  } catch (err) {
    log.error("Failed to resolve channel adapter", { connectionId: connection.id, err });
    return undefined;
  }
}

// Pushes the assistant's reply out over the session's channel, if it has one. Best-effort —
// mirrors notifyIssueOfPullRequest's isolation exactly: nothing here can fail the run.
export async function notifySessionOfReply(
  orgId: number,
  session: Session,
  text: string,
  emitEvent: (type: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (session.origin !== "telegram" || !session.externalThreadRef) return;
  const externalThreadRef = session.externalThreadRef;

  let connectionId: number | undefined;
  try {
    // A session with no owning task shouldn't happen for new Telegram sessions after the
    // task-integration redesign, but sends unprefixed rather than failing if it ever does. This
    // lookup stays inside the try along with everything else in this function, on purpose —
    // nothing here can be allowed to fail the run, and moving it above the try would let a
    // transient DB error escape uncaught instead of degrading to an unprefixed send.
    const task = await getTaskBySessionId(session.id);
    const prefixedText = task ? `[${task.ref}] ${text}` : text;

    const resolved = await resolveChannelAdapter(orgId, task?.assigneeAgentId);
    if (!resolved) return;
    connectionId = resolved.connection.id;
    await resolved.adapter.send(externalThreadRef, prefixedText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emitEvent("error", { message: `Couldn't deliver reply to Telegram: ${message}` });
    if (connectionId !== undefined) {
      await setConnectionHealth(orgId, connectionId, "needs-attention");
    }
  }
}

// Starts re-sending Telegram's "typing…" chat action every ~4s (it auto-expires around 5s) for as
// long as the turn is running. Returns a stop function; always safe to call, even for a
// non-telegram session (no-ops). Failures are swallowed — a missed typing indicator is cosmetic,
// never worth surfacing as a run error the way a failed reply delivery is.
export function startTypingIndicator(orgId: number, session: Session): () => void {
  if (session.origin !== "telegram" || !session.externalThreadRef) {
    return () => {};
  }
  const externalThreadRef = session.externalThreadRef;

  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const resolved = await resolveChannelAdapter(orgId, session.agentId).catch(() => undefined);
    if (!resolved || stopped) return;
    await resolved.adapter.sendTyping(externalThreadRef).catch((err) => {
      log.error("Failed to send typing indicator", { orgId, err });
    });
  };

  void tick();
  const interval = setInterval(() => void tick(), TYPING_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
