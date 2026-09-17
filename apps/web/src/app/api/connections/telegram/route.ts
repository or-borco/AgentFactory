import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createConnection, createConnectionSecret, listConnections } from "@agentfactory/db";
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

  const existing = (await listConnections(ctx.orgId)).find((c) => c.kind === "channel" && c.provider === "telegram");
  if (existing) {
    return NextResponse.json(
      { error: `Already connected to ${existing.label}. Disconnect it before connecting another.` },
      { status: 409 },
    );
  }

  const body = await request.json();
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  if (!botToken) {
    return NextResponse.json({ error: "botToken is required." }, { status: 400 });
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

  const webhookSecret = randomBytes(16).toString("hex");
  const setWebhookRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${baseUrl}/api/webhooks/telegram/${webhookSecret}`,
      secret_token: webhookSecret,
    }),
  });
  const setWebhookBody = (await setWebhookRes.json()) as { ok: boolean; description?: string };
  if (!setWebhookBody.ok) {
    return NextResponse.json({ error: setWebhookBody.description ?? "Could not register the Telegram webhook." }, { status: 400 });
  }

  const credentialRef = await createConnectionSecret(ctx.orgId, { botToken });
  const connection = await createConnection(ctx.orgId, {
    provider: "telegram",
    kind: "channel",
    label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : `@${botUsername}`,
    auth: "api_token",
    credentialRef,
    config: { botUsername, webhookSecret },
  });

  return NextResponse.json(connection, { status: 201 });
}
