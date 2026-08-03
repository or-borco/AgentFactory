import { NextResponse } from "next/server";
import { deleteConnection, getConnection } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// Deletes AgentFactory's record of the connection. Doesn't uninstall the GitHub App on
// GitHub's side — the org can do that from their GitHub account settings for full revocation.
export async function DELETE(_request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { connectionId } = await params;
  const connection = await getConnection(Number(connectionId));
  if (!connection || connection.orgId !== ctx.orgId) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  await deleteConnection(connection.id);
  return new NextResponse(null, { status: 204 });
}
