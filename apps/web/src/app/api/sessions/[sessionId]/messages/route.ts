import { NextResponse } from "next/server";
import { mockStore } from "@/server/mock-store";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return NextResponse.json(mockStore.listMessages(sessionId));
}

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const { text } = await request.json();
  const result = mockStore.sendMessage(sessionId, text);
  return NextResponse.json(result, { status: 201 });
}
