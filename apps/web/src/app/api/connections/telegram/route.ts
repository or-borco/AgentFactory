import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createConnection, createConnectionSecret, getAgent } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

interface TelegramMeResponse {
  ok: boolean;
  result?: { username?: string };
  description?: string;
}

// Verifies the token (getMe) and registers the webhook before anything is persisted — same
// fail-closed ordering as the Jira connect route (POST /api/connections/jira): if setup can't be
// verified end to end, no half-configured connection is left behind.
export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  if (!botToken) {
    return NextResponse.json({ error: "botToken is required." }, { status: 400 });
  }

  const agentIdRaw = typeof body.agentId === "number" ? body.agentId : null;
  if (!agentIdRaw) {
    return NextResponse.json({ error: "agentId is required." }, { status: 400 });
  }
  const agent = await getAgent(agentIdRaw);
  if (!agent || agent.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Agent not found." }, { status: 404 });
  }

  const baseUrl = process.env.PUBLIC_APP_URL;
  if (!baseUrl) {
    return NextResponse.json({ error: "This environment has no PUBLIC_APP_URL configured — ask an admin." }, { status: 500 });
  }

  const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const me = (await meRes.json()) as TelegramMeResponse;
  if (!me.ok || !me.result?.username) {
    return NextResponse.json({ error: me.description ?? "Could not verify this Telegram bot token." }, { status: 400 });
  }
  const botUsername = me.result.username;

  // Two independently-generated secrets, deliberately not one value used twice: the path segment
  // is the part that can leak through a proxy/access log or a Referer, and the secret_token — which
  // Telegram echoes back in X-Telegram-Bot-Api-Secret-Token and never appears in a URL — is what
  // makes that leak insufficient on its own to forge an update.
  const webhookSecret = randomBytes(16).toString("hex");
  const telegramSecretToken = randomBytes(16).toString("hex");
  const setWebhookRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${baseUrl}/api/webhooks/telegram/${webhookSecret}`,
      secret_token: telegramSecretToken,
    }),
  });
  const setWebhookBody = (await setWebhookRes.json()) as { ok: boolean; description?: string };
  if (!setWebhookBody.ok) {
    return NextResponse.json({ error: setWebhookBody.description ?? "Could not register the Telegram webhook." }, { status: 400 });
  }

  // Register slash commands so they appear in Telegram's autocomplete menu when users type /.
  // Best-effort: a failure here doesn't prevent the connection from working.
  await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "tasks", description: "Show your tasks and start a new one" },
        { command: "start", description: "Show your tasks and start a new one" },
      ],
    }),
  }).catch(() => {});

  const credentialRef = await createConnectionSecret(ctx.orgId, { botToken });
  const connection = await createConnection(ctx.orgId, {
    provider: "telegram",
    kind: "channel",
    label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : `@${botUsername}`,
    auth: "api_token",
    credentialRef,
    config: { botUsername, webhookSecret, telegramSecretToken },
    agentId: agentIdRaw,
  });

  return NextResponse.json(connection, { status: 201 });
}
