import { NextResponse } from "next/server";
import { getConnection, revokeAuthorizedUser } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function DELETE(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const connectionId = Number(new URL(request.url).searchParams.get("connectionId"));
  const connection = Number.isFinite(connectionId) ? await getConnection(ctx.orgId, connectionId) : undefined;
  if (!connection || connection.orgId !== ctx.orgId || connection.kind !== "channel") {
    return NextResponse.json({ error: "Telegram connection not found" }, { status: 404 });
  }

  const { userId } = await params;
  await revokeAuthorizedUser(connectionId, Number(userId));
  return new NextResponse(null, { status: 204 });
}
