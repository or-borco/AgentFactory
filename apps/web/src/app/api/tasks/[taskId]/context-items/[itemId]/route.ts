import { NextResponse } from "next/server";
import { deleteTaskContextItemForOrg } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function DELETE(_req: Request, { params }: { params: Promise<{ taskId: string; itemId: string }> }) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { itemId } = await params;
  const deleted = await deleteTaskContextItemForOrg(Number(itemId), ctx.orgId);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
