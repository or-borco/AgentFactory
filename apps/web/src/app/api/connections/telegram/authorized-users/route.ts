import { NextResponse } from "next/server";
import { getConnection, listAuthorizedUsers } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connectionId = Number(new URL(request.url).searchParams.get("connectionId"));
  const connection = Number.isFinite(connectionId) ? await getConnection(ctx.orgId, connectionId) : undefined;
  if (!connection || connection.orgId !== ctx.orgId || connection.kind !== "channel") {
    return NextResponse.json({ error: "Telegram connection not found" }, { status: 404 });
  }

  return NextResponse.json(await listAuthorizedUsers(connectionId));
}
