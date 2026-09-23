import { NextResponse } from "next/server";
import { CODEBASE_SETUP_COMMAND_MAX_CHARS, listCodebaseSettings, setCodebaseSetupCommand } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";

const REPO_FULL_NAME_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(await listCodebaseSettings(ctx.orgId));
}

export async function PUT(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => undefined)) as
    | { repoFullName?: unknown; setupCommand?: unknown }
    | undefined;
  const repoFullName = body?.repoFullName;
  const setupCommand = body?.setupCommand ?? null;

  if (typeof repoFullName !== "string" || !REPO_FULL_NAME_PATTERN.test(repoFullName)) {
    return NextResponse.json({ error: "repoFullName must look like owner/repo" }, { status: 400 });
  }
  if (setupCommand !== null && typeof setupCommand !== "string") {
    return NextResponse.json({ error: "setupCommand must be a string or null" }, { status: 400 });
  }
  if (typeof setupCommand === "string" && setupCommand.trim().length > CODEBASE_SETUP_COMMAND_MAX_CHARS) {
    return NextResponse.json(
      { error: `setupCommand must be at most ${CODEBASE_SETUP_COMMAND_MAX_CHARS} characters` },
      { status: 400 },
    );
  }

  return NextResponse.json(await setCodebaseSetupCommand(ctx.orgId, repoFullName, setupCommand));
}
