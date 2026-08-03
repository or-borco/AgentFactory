import { NextResponse } from "next/server";
import { listOrgMembers } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await listOrgMembers(ctx.orgId));
}
