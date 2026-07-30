import { NextResponse } from "next/server";
import { createMessage, createRun, getSession, listMessages, touchSessionActivity } from "@agentfactory/db";
import { enqueueRunJob } from "@agentfactory/queue";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return NextResponse.json(await listMessages(Number(sessionId)));
}

export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const id = Number(sessionId);
  const { text } = await request.json();

  const userMessage = await createMessage(id, "user", text);
  await touchSessionActivity(id);
  const session = await getSession(id);

  const run = await createRun(id, userMessage.id);
  await enqueueRunJob(run.id);

  return NextResponse.json({ userMessage, session, runId: run.id }, { status: 201 });
}
