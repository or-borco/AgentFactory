import { NextResponse } from "next/server";
import { mockStore } from "@/server/mock-store";

export async function GET() {
  return NextResponse.json(mockStore.listConnections());
}
