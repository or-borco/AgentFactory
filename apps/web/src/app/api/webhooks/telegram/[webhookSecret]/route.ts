import { NextResponse } from "next/server";
import {
  authorizeExternalUser,
  clearRedemptionAttempts,
  createMessage,
  createRun,
  createSession,
  findChannelConnectionByWebhookSecret,
  findSessionByExternalThread,
  getAgent,
  getAuthorizationStatus,
  getConnectionCredentialRef,
  isInCooldown,
  listAgents,
  looksLikeInviteCode,
  readConnectionSecret,
  recordFailedRedemption,
  redeemInviteCode,
  touchSessionActivity,
} from "@agentfactory/db";
import { createChannelAdapter, type ChannelAdapter } from "@agentfactory/integrations";
import { enqueueRunJob } from "@agentfactory/queue";
import type { Agent, Connection } from "@agentfactory/core";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("webhooks:telegram");

const WELCOME_MESSAGE = (orgLabel: string) =>
  `This connects you to ${orgLabel}'s agents on AgentFactory. Send the invite code your admin gave you to get started.`;
const INVALID_CODE_MESSAGE = "That code isn't valid — ask your admin for a new one.";
const COOLDOWN_MESSAGE = "Too many invalid codes — try again in a bit.";
const REVOKED_MESSAGE = "Your access was revoked — ask your admin for a new invite.";
const NO_AGENTS_MESSAGE = "No agents are set up for this org yet — ask your admin.";
const ASK_FOR_CODE_MESSAGE = "Send your invite code to get started.";
const PICK_AGENT_PROMPT = "Who would you like to talk to?";

export async function POST(request: Request, { params }: { params: Promise<{ webhookSecret: string }> }) {
  const { webhookSecret } = await params;

  const resolved = await findChannelConnectionByWebhookSecret(webhookSecret);
  if (!resolved) return new NextResponse(null, { status: 404 });
  const { connection, orgId, secretToken } = resolved;

  // Defense in depth against the path secret alone leaking (e.g. via a proxy/access log): Telegram
  // echoes back whatever secret_token was registered with setWebhook, and the connect route
  // deliberately generates that as a *separate* random value from the path segment, so knowing the
  // URL is not enough to satisfy this check. A connection with no stored token can't be
  // authenticated at all — treat it as unknown rather than falling back to the path secret, which
  // would collapse the two layers back into one.
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!secretToken || secretHeader !== secretToken) return new NextResponse(null, { status: 404 });

  const credentialRef = await getConnectionCredentialRef(orgId, connection.id);
  if (credentialRef == null) return new NextResponse(null, { status: 200 });
  const secret = await readConnectionSecret(orgId, credentialRef);
  if (!secret) return new NextResponse(null, { status: 200 });

  const adapter = createChannelAdapter(connection, secret);
  const raw = await request.json();
  let inbound;
  try {
    inbound = adapter.receive(raw);
  } catch {
    return new NextResponse(null, { status: 200 }); // unrecognized update shape — ack and ignore
  }

  try {
    await handleInbound(adapter, orgId, connection, inbound);
  } catch (err) {
    // Never let an internal error surface as a non-200 to Telegram — a 5xx here triggers
    // Telegram's own retry-storm behavior, exactly what this design exists to avoid. A transient
    // Postgres/Redis blip just means this update is dropped; Telegram doesn't get a signal to
    // resend it, but that's preferable to a retry storm hammering an already-struggling backend.
    log.error("Failed to handle inbound Telegram update", { connectionId: connection.id, err });
  }
  return new NextResponse(null, { status: 200 });
}

async function handleInbound(
  adapter: ChannelAdapter,
  orgId: number,
  connection: Connection,
  inbound: ReturnType<ChannelAdapter["receive"]>,
) {
  const { externalUserId } = inbound;
  const session = await findSessionByExternalThread(orgId, "telegram", externalUserId);
  // Authorization is checked before the session/no-session split, not inside each arm, because
  // admission has to work identically either way. An existing session must never let an
  // unauthorized chat through, and — just as importantly — must never block a fresh invite code
  // from being redeemed: `authorizeExternalUser` has no other caller and there's no admin UI to
  // re-authorize a chat, so a session branch that short-circuited before redemption would leave
  // every pre-existing chat permanently locked out after a routine disconnect/reconnect.
  const status = await getAuthorizationStatus(connection.id, externalUserId);

  if (status !== "authorized") {
    if (inbound.isStartCommand && !inbound.startPayload) {
      await adapter.send(externalUserId, WELCOME_MESSAGE(connection.label));
      return;
    }

    // Only text actually shaped like a code counts as a redemption attempt. Treating every
    // message as one meant a newcomer typing "hi" spent one of their five attempts and could be
    // locked out without ever being told what to send. Upper-cased because the alphabet is
    // uppercase-only and `code` is a case-sensitive text column — a hand-typed lowercase code is a
    // real attempt at a real code, not a different code, so it shouldn't fail for casing alone.
    const candidateCode = (inbound.startPayload ?? inbound.text?.trim())?.toUpperCase();
    if (!candidateCode || !looksLikeInviteCode(candidateCode)) {
      await adapter.send(externalUserId, status === "revoked" ? REVOKED_MESSAGE : ASK_FOR_CODE_MESSAGE);
      return;
    }
    if (!(await attemptRedemption(adapter, connection, externalUserId, candidateCode))) return;

    // Authorized now — but the message that got them here was the code itself, not something to
    // run. A chat that still has its session just gets it back; a new one picks an agent.
    const boundAgent = session ? await getAgent(session.agentId) : undefined;
    if (boundAgent) {
      await adapter.send(externalUserId, `You're now talking to ${boundAgent.name}.`);
      return;
    }
    await sendAgentMenu(adapter, orgId, externalUserId);
    return;
  }

  if (session) {
    if (!inbound.text) return; // a stray callback on an already-bound session — nothing to do

    const userMessage = await createMessage(session.id, "user", inbound.text);
    await touchSessionActivity(session.id);
    const run = await createRun(session.id, userMessage.id);
    // Cosmetic, and never worth stranding a run over: the whole handler runs inside an
    // always-200 try/catch, so a throw here (429, a user who blocked the bot, a transient 5xx)
    // would be swallowed *after* the runs row exists but *before* the job is enqueued, leaving a
    // permanently `queued` run with nothing to pick it up. Same treatment as
    // startTypingIndicator in apps/worker/src/channel-notify.ts.
    try {
      await adapter.sendTyping(externalUserId);
    } catch (err) {
      log.warn("Failed to send Telegram typing indicator", { connectionId: connection.id, err });
    }
    await enqueueRunJob(run.id);
    return;
  }

  // Authorized, no session yet: expect a menu button tap.
  if (inbound.callbackData?.startsWith("agent:")) {
    const agentId = Number(inbound.callbackData.slice("agent:".length));
    // A tampered or malformed callback_data (e.g. "agent:xyz") parses to NaN — Number.isFinite
    // catches that before it ever reaches getAgent, same fallback as a stale/deleted agent id.
    const agent = Number.isFinite(agentId) ? await getAgent(agentId) : undefined;
    // The agent named in a stale callback (deleted since the menu was sent, or a tampered
    // callback_data) no longer exists — fall back to re-showing a fresh menu rather than creating
    // a session pointed at nothing.
    if (!agent || agent.orgId !== orgId) {
      await sendAgentMenu(adapter, orgId, externalUserId);
      return;
    }

    const bound = await bindSession(orgId, agent, externalUserId);
    await adapter.send(externalUserId, `You're now talking to ${bound.name}.`);
    return;
  }

  await sendAgentMenu(adapter, orgId, externalUserId);
}

/**
 * Runs one invite-code redemption for a chat that isn't currently authorized, replying with the
 * cooldown/invalid message on failure. Returns whether the chat came out of it authorized. Shared
 * by the has-a-session and no-session paths: whether a session exists changes what happens *after*
 * admission, never how admission itself works.
 */
async function attemptRedemption(
  adapter: ChannelAdapter,
  connection: Connection,
  externalUserId: string,
  candidateCode: string,
): Promise<boolean> {
  if (await isInCooldown(connection.id, externalUserId)) {
    await adapter.send(externalUserId, COOLDOWN_MESSAGE);
    return false;
  }
  const redeemed = await redeemInviteCode(candidateCode, externalUserId);
  // redeemInviteCode matches purely on the globally-unique code column — it has no notion of
  // which bot the message came in on. A code minted for a different org's connection (leaked,
  // or pasted into the wrong bot) still redeems successfully here, so it must be rejected
  // exactly like an invalid code rather than authorizing against the WRONG connection. The
  // code is already burned by the atomic UPDATE at this point — that's an accepted tradeoff
  // (re-issuing it would reintroduce the race redeemInviteCode's atomicity exists to avoid).
  if (!redeemed || redeemed.connectionId !== connection.id) {
    await recordFailedRedemption(connection.id, externalUserId);
    await adapter.send(externalUserId, INVALID_CODE_MESSAGE);
    return false;
  }
  await clearRedemptionAttempts(connection.id, externalUserId);
  await authorizeExternalUser(connection.id, externalUserId);
  return true;
}

/**
 * Creates this chat's session, or adopts the one a concurrent duplicate delivery just created.
 * sessions_org_origin_external_thread_idx turns the double-tap race into a 23505 instead of a
 * second session row; swallowing it and re-reading keeps the outcome identical for the user
 * rather than turning a race into an error. Returns the agent the surviving session is bound to,
 * which is the loser's agent if two different menu buttons raced.
 */
async function bindSession(orgId: number, agent: Agent, externalUserId: string): Promise<Agent> {
  try {
    await createSession(orgId, agent.id, `Telegram — ${agent.name}`, {
      origin: "telegram",
      externalThreadRef: externalUserId,
    });
    return agent;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await findSessionByExternalThread(orgId, "telegram", externalUserId);
    if (!existing) throw err;
    if (existing.agentId === agent.id) return agent;
    return (await getAgent(existing.agentId)) ?? agent;
  }
}

// Drizzle wraps driver errors in a DrizzleQueryError and hangs the original PostgresError (which
// is where SQLSTATE lives) off `cause`, so the check has to walk the chain rather than read
// `err.code` off the top-level error.
function isUniqueViolation(err: unknown): boolean {
  for (let current = err; current instanceof Error; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

async function sendAgentMenu(adapter: ChannelAdapter, orgId: number, externalUserId: string): Promise<void> {
  const agents = await listAgents(orgId);
  if (agents.length === 0) {
    await adapter.send(externalUserId, NO_AGENTS_MESSAGE);
    return;
  }
  await adapter.sendMenu(
    externalUserId,
    PICK_AGENT_PROMPT,
    agents.map((agent) => ({ label: agent.name, value: `agent:${agent.id}` })),
  );
}
