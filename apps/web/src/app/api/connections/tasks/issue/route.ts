import { NextResponse } from "next/server";
import { requireAuthContext } from "@/server/auth";
import { resolveTaskProvider } from "@/server/task-provider";

// Named for the connection *kind*, not the provider — connections/tasks/issue, not
// connections/jira/issue — even though createTaskProvider only resolves to a Jira adapter today.
// See Design decision 14 in docs/superpowers/specs/2026-09-12-jira-integration-design.md: looking
// up an issue never touches provider-specific fields, only the generic
// parseIssueReference/fetchIssue pair on the TaskProvider port, so this route (unlike the connect
// flow) costs nothing to keep provider-neutral.
//
// This route only reads: it resolves the org's tasks connection, parses the reference, and fetches
// the issue. It does not download attachment bytes or write anything — that happens once a task
// actually exists to attach documents to (see the spec's "Flow: attachments").
export async function GET(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ref = new URL(request.url).searchParams.get("ref");

  const resolved = await resolveTaskProvider(ctx.orgId);
  if (!resolved) {
    return NextResponse.json(
      { error: "No task-tracking tool is connected for this org.", code: "no_connection" },
      { status: 404 },
    );
  }

  const key = ref ? resolved.provider.parseIssueReference(ref) : undefined;
  if (!key) {
    return NextResponse.json({ error: "Could not parse an issue reference from ref." }, { status: 400 });
  }

  const issue = await resolved.provider.fetchIssue(key);
  if (!issue) {
    return NextResponse.json({ error: `Issue ${key} was not found.` }, { status: 404 });
  }

  return NextResponse.json(issue);
}
