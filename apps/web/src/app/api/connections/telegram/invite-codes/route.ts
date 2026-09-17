import { NextResponse } from "next/server";
import { generateInviteCode, getConnection, listInviteCodes } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

function isOwnedTelegramConnection(orgId: number, connection: Awaited<ReturnType<typeof getConnection>>): boolean {
  return Boolean(connection && connection.orgId === orgId && connection.kind === "channel" && connection.provider === "telegram");
}

export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const connectionId = Number(body.connectionId);
  const connection = Number.isFinite(connectionId) ? await getConnection(ctx.orgId, connectionId) : undefined;
  if (!isOwnedTelegramConnection(ctx.orgId, connection)) {
    return NextResponse.json({ error: "Telegram connection not found" }, { status: 404 });
  }

  const invite = await generateInviteCode(ctx.orgId, connectionId, ctx.user.id);
  const botUsername = (connection!.config as { botUsername?: string }).botUsername;
  const deepLink = botUsername ? `https://t.me/${botUsername}?start=${invite.code}` : undefined;

  return NextResponse.json({ ...invite, deepLink }, { status: 201 });
}

export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connectionId = Number(new URL(request.url).searchParams.get("connectionId"));
  const connection = Number.isFinite(connectionId) ? await getConnection(ctx.orgId, connectionId) : undefined;
  if (!isOwnedTelegramConnection(ctx.orgId, connection)) {
    return NextResponse.json({ error: "Telegram connection not found" }, { status: 404 });
  }

  return NextResponse.json(await listInviteCodes(connectionId));
}
