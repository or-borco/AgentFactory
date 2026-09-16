import { NextResponse } from "next/server";
import { getRepoMap } from "@agentfactory/db";
import { enqueueRepoMapWarmJob } from "@agentfactory/queue";
import { resolveScmConnection } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";
import { createLogger } from "@agentfactory/logger";

const log = createLogger("api:repos:map-status");

// Answers "is this repo mapped for its current commit?" for the task-creation and task-edit
// forms' wait-choice banner. checkable:false means "couldn't determine" (no connected SCM
// provider can see the repo, API error) — every caller treats that identically to "not mapped,
// but skip the prompt", never as an error to surface.
export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const repoFullName = new URL(request.url).searchParams.get("codebase");
  if (!repoFullName) return NextResponse.json({ error: "codebase is required" }, { status: 400 });

  const resolved = await resolveScmConnection(ctx.orgId, repoFullName).catch(() => undefined);
  const sha = resolved
    ? await resolved.provider.resolveDefaultBranchSha(resolved.connection, repoFullName).catch(() => undefined)
    : undefined;
  if (!sha) return NextResponse.json({ mapped: false, checkable: false });

  const cached = await getRepoMap(ctx.orgId, repoFullName, sha);
  return NextResponse.json({ mapped: Boolean(cached), checkable: true });
}

// Triggers the warm job ahead of the form actually submitting — see the design spec's "delay the
// submit itself" decision. Best-effort, matching every other warm-trigger call site: a queue
// outage must not block the caller, since a missed warm just means the poll on the other end of
// this feature (or, failing that, the run itself) pays the generation cost as it already does.
export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const repoFullName = body.codebase;
  if (!repoFullName) return NextResponse.json({ error: "codebase is required" }, { status: 400 });

  await enqueueRepoMapWarmJob(ctx.orgId, repoFullName).catch((err: unknown) => {
    log.error("Failed to enqueue repo map warm job", { repoFullName, err });
  });
  return new NextResponse(null, { status: 204 });
}
