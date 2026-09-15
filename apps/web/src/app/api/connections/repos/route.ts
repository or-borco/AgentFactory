import { NextResponse } from "next/server";
import { listConnections } from "@agentfactory/db";
import { getScmProvider } from "@agentfactory/scm";
import type { RepoOption } from "@agentfactory/scm";
import { requireAuthContext } from "@/server/auth";

// Merges repo lists from every one of the org's scm connections, across every registered
// provider — dedupes by (provider, id) in case the same repo is reachable via more than one
// connection (e.g. two installations of the same GitHub App account).
function dedupeRepos(repos: RepoOption[]): RepoOption[] {
  const seen = new Set<string>();
  return repos.filter((repo) => {
    const key = `${repo.provider}:${repo.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const scmConnections = (await listConnections(ctx.orgId)).filter((c) => c.kind === "scm");

  const repoLists = await Promise.all(
    scmConnections.map(async (connection): Promise<RepoOption[]> => {
      const provider = getScmProvider(connection.provider);
      if (!provider) return [];
      try {
        const repos = await provider.listRepos(connection);
        return repos.map((r) => ({ ...r, provider: connection.provider }));
      } catch {
        // A revoked/broken installation shouldn't take down the whole picker — skip it.
        return [];
      }
    }),
  );

  return NextResponse.json(dedupeRepos(repoLists.flat()));
}
