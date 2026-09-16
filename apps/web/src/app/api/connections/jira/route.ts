import { NextResponse } from "next/server";
import { createConnection, createConnectionSecret, getConnection, listConnections, updateConnection } from "@agentfactory/db";
import { JiraTaskProvider, ProviderError } from "@agentfactory/integrations";
import { requireAuthContext } from "@/server/auth";

// Cloud only. Strips a trailing slash (and any path/query the user pasted along with the host)
// via URL.origin, and rejects anything that isn't an https://*.atlassian.net address.
function normalizeSiteUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:") return undefined;
  if (!url.hostname.toLowerCase().endsWith(".atlassian.net")) return undefined;

  return url.origin;
}

// Connects a Jira Cloud site as the org's `tasks`-kind connection.
export async function POST(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  // First, before anything else — including validating the submitted siteUrl — so a doomed
  // request never makes a wasted Jira API call. This is Design decision 15: at most one
  // `kind: "tasks"` connection per org, any provider, not just Jira.
  const existingTasksConnection = (await listConnections(ctx.orgId)).find((c) => c.kind === "tasks");
  if (existingTasksConnection) {
    return NextResponse.json(
      {
        error: `Already connected to ${existingTasksConnection.label}. Disconnect it before connecting another.`,
      },
      { status: 409 },
    );
  }

  const siteUrl = normalizeSiteUrl(body.siteUrl);
  if (!siteUrl) {
    return NextResponse.json(
      { error: "siteUrl must be an https:// Jira Cloud address (a *.atlassian.net host)." },
      { status: 400 },
    );
  }

  const accountEmail = typeof body.accountEmail === "string" ? body.accountEmail.trim() : "";
  const apiToken = typeof body.apiToken === "string" ? body.apiToken : "";
  if (!accountEmail || !apiToken) {
    return NextResponse.json({ error: "accountEmail and apiToken are required." }, { status: 400 });
  }

  // No Connection row exists yet at this point in the flow, so the generic createTaskProvider()
  // factory (which dispatches on connection.provider) doesn't fit — JiraTaskProvider is
  // constructed directly from the submitted credentials instead.
  let verified: { accountId: string; displayName: string };
  try {
    verified = await new JiraTaskProvider({ siteUrl, accountEmail, apiToken }).verify();
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "Could not verify the Jira credentials.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Order from here matters: verify() already succeeded, so it's now safe to write. Secret first,
  // then the connection that references it — a failure between the two leaves an orphaned secret
  // rather than a connection pointing at nothing.
  const credentialRef = await createConnectionSecret(ctx.orgId, { apiToken });
  const connection = await createConnection(ctx.orgId, {
    provider: "jira",
    kind: "tasks",
    label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : siteUrl,
    auth: "api_token",
    credentialRef,
    config: {
      siteUrl,
      accountEmail,
      accountId: verified.accountId,
      writeBack: { comment: true },
    },
  });

  return NextResponse.json(connection, { status: 201 });
}

// Updates the org's write-back config for its Jira connection. Comment-on-PR is the only setting
// there is (Product decision 3 — transitions are permanently out of scope, not just
// undefaulted). Merges into the existing `config` rather than replacing it, so
// siteUrl/accountEmail/accountId survive the write.
export async function PATCH(request: Request) {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const connectionId = Number(body.connectionId);
  if (!Number.isFinite(connectionId)) {
    return NextResponse.json({ error: "connectionId is required." }, { status: 400 });
  }

  const comment = body.writeBack?.comment;
  if (typeof comment !== "boolean") {
    return NextResponse.json({ error: "writeBack.comment must be a boolean." }, { status: 400 });
  }

  const connection = await getConnection(ctx.orgId, connectionId);
  if (!connection || connection.kind !== "tasks") {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const updated = await updateConnection(ctx.orgId, connectionId, {
    config: { ...connection.config, writeBack: { comment } },
  });

  return NextResponse.json(updated);
}
