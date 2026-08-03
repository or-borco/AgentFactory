import { NextResponse } from "next/server";
import { listConnections } from "@agentfactory/db";
import { requireAuthContext } from "@/server/auth";
import { dedupeRepos, listInstallationRepos } from "@/server/github-app";

export async function GET() {
  const ctx = await requireAuthContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const githubConnections = (await listConnections(ctx.orgId)).filter((c) => c.provider === "github");

  const repoLists = await Promise.all(
    githubConnections.map(async (connection) => {
      const installationId = connection.config.installationId;
      if (typeof installationId !== "number") return [];
      try {
        return await listInstallationRepos(installationId);
      } catch {
        // A revoked/broken installation shouldn't take down the whole picker — skip it.
        return [];
      }
    }),
  );

  return NextResponse.json(dedupeRepos(repoLists));
}
