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
  readConnectionSecret,
  recordFailedRedemption,
  redeemInviteCode,
  touchSessionActivity,
} from "@agentfactory/db";
import { createChannelAdapter, type ChannelAdapter } from "@agentfactory/integrations";
import { enqueueRunJob } from "@agentfactory/queue";
import type { Connection } from "@agentfactory/core";

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
  const { connection, orgId } = resolved;

  // Defense in depth against the path secret alone leaking (e.g. via logs): Telegram echoes back
  // whatever secret_token was registered with setWebhook (Task 8), which is the same value as the
  // path segment — both must agree.
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secretHeader !== webhookSecret) return new NextResponse(null, { status: 404 });

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

  await handleInbound(adapter, orgId, connection, inbound);
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

  if (session) {
    const status = await getAuthorizationStatus(connection.id, externalUserId);
    if (status === "revoked") {
      await adapter.send(externalUserId, REVOKED_MESSAGE);
      return;
    }
    if (!inbound.text) return; // a stray callback on an already-bound session — nothing to do

    const userMessage = await createMessage(session.id, "user", inbound.text);
    await touchSessionActivity(session.id);
    const run = await createRun(session.id, userMessage.id);
    await adapter.sendTyping(externalUserId);
    await enqueueRunJob(run.id);
    return;
  }

  const authStatus = await getAuthorizationStatus(connection.id, externalUserId);
  if (authStatus !== "authorized") {
    if (inbound.isStartCommand && !inbound.startPayload) {
      await adapter.send(externalUserId, WELCOME_MESSAGE(connection.label));
      return;
    }

    const candidateCode = inbound.startPayload ?? inbound.text?.trim();
    if (candidateCode) {
      if (await isInCooldown(connection.id, externalUserId)) {
        await adapter.send(externalUserId, COOLDOWN_MESSAGE);
        return;
      }
      const redeemed = await redeemInviteCode(candidateCode, externalUserId);
      if (!redeemed) {
        await recordFailedRedemption(connection.id, externalUserId);
        await adapter.send(externalUserId, INVALID_CODE_MESSAGE);
        return;
      }
      await clearRedemptionAttempts(connection.id, externalUserId);
      await authorizeExternalUser(connection.id, externalUserId);
      await sendAgentMenu(adapter, orgId, externalUserId);
      return;
    }

    await adapter.send(externalUserId, ASK_FOR_CODE_MESSAGE);
    return;
  }

  // Authorized, no session yet: expect a menu button tap.
  if (inbound.callbackData?.startsWith("agent:")) {
    const agentId = Number(inbound.callbackData.slice("agent:".length));
    const agent = await getAgent(agentId);
    // The agent named in a stale callback (deleted since the menu was sent, or a tampered
    // callback_data) no longer exists — fall back to re-showing a fresh menu rather than creating
    // a session pointed at nothing.
    if (!agent || agent.orgId !== orgId) {
      await sendAgentMenu(adapter, orgId, externalUserId);
      return;
    }

    await createSession(orgId, agent.id, `Telegram — ${agent.name}`, {
      origin: "telegram",
      externalThreadRef: externalUserId,
    });
    await adapter.send(externalUserId, `You're now talking to ${agent.name}.`);
    return;
  }

  await sendAgentMenu(adapter, orgId, externalUserId);
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
