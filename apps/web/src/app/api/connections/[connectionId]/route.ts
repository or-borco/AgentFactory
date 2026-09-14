import { NextResponse } from "next/server";
import { deleteConnection, deleteConnectionSecret, getConnection, getConnectionCredentialRef } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

// Deletes AgentFactory's record of the connection. Doesn't uninstall the GitHub App on
// GitHub's side — the org can do that from their GitHub account settings for full revocation.
export async function DELETE(_request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { connectionId } = await params;
  const id = Number(connectionId);
  const connection = await getConnection(ctx.orgId, id);
  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // The FK is `set null`, so this ordering isn't load-bearing for referential integrity — but
  // deleting the secret first means a failure mid-way leaves a broken connection rather than an
  // orphaned credential row sitting in connection_secrets.
  const credentialRef = await getConnectionCredentialRef(ctx.orgId, id);
  if (credentialRef) {
    await deleteConnectionSecret(ctx.orgId, credentialRef);
  }

  await deleteConnection(connection.id);
  return new NextResponse(null, { status: 204 });
}
