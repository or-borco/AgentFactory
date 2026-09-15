import { listConnections } from "@agentfactory/db";
import type { Connection, ConnectionProvider } from "@agentfactory/core";
import { githubScmProvider } from "./github";
import type { ScmProvider } from "./types";

// Exported (rather than a private module constant) so registry.test.ts can register a stub
// second provider to exercise multi-provider dispatch — production code never pushes to this
// beyond the fixed list below; there is exactly one real adapter until a second one ships.
export const providers: ScmProvider[] = [githubScmProvider]; // future: push a second adapter here

export function getScmProvider(id: ConnectionProvider): ScmProvider | undefined {
  return providers.find((p) => p.id === id);
}

// The generalized findInstallationForRepo: group the org's kind:"scm" connections by
// provider, try each registered provider's own findRepoAccess in turn, first hit wins.
export async function resolveScmConnection(
  orgId: number,
  repoFullName: string,
): Promise<{ connection: Connection; provider: ScmProvider } | undefined> {
  const scmConnections = (await listConnections(orgId)).filter((c) => c.kind === "scm");
  for (const provider of providers) {
    const own = scmConnections.filter((c) => c.provider === provider.id);
    const connection = await provider.findRepoAccess(own, repoFullName);
    if (connection) return { connection, provider };
  }
  return undefined;
}

// Free-text task descriptions are parsed for an issue link before any repo or provider is
// known — there's nothing to resolve a provider from yet, so every registered provider's own
// parser is tried in turn.
export function parseIssueReferenceAcrossProviders(
  text: string,
): { repoFullName: string; issueNumber: number; provider: ConnectionProvider } | undefined {
  for (const provider of providers) {
    const match = provider.parseIssueReference(text);
    if (match) return { ...match, provider: provider.id };
  }
  return undefined;
}
