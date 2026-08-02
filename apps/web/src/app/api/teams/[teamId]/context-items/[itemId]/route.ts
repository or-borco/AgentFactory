import { NextResponse } from "next/server";
import { deleteTeamContextItem } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function DELETE(_req: Request, { params }: { params: Promise<{ teamId: string; itemId: string }> }) {
  if (!(await requireAuthContext())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { itemId } = await params;
  await deleteTeamContextItem(Number(itemId));
  return new NextResponse(null, { status: 204 });
}
