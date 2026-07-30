import { NextResponse } from "next/server";
import { clearSession } from "@/server/auth";

export async function POST() {
  await clearSession();
  return new NextResponse(null, { status: 204 });
}
