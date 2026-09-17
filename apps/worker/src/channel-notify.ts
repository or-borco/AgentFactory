import type { Session } from "@agentfactory/core";
import { getConnectionCredentialRef, listConnections, readConnectionSecret, setConnectionHealth } from "@agentfactory/db";
import { createChannelAdapter } from "@agentfactory/integrations";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("channel-notify");
const TYPING_REFRESH_MS = 4_000;

// Mirrors task-notify.ts's resolveTaskProvider exactly, for the same reason (apps/worker and
// apps/web are separate processes with no shared-code path). Resolves the org's single
// channel/telegram connection.
async function resolveChannelAdapter(orgId: number) {
  const connection = (await listConnections(orgId)).find((c) => c.kind === "channel" && c.provider === "telegram");
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
    const resolved = await resolveChannelAdapter(orgId);
    if (!resolved) return;
    connectionId = resolved.connection.id;
    await resolved.adapter.send(externalThreadRef, text);
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
    const resolved = await resolveChannelAdapter(orgId).catch(() => undefined);
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
