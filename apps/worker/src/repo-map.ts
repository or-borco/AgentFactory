import { getRepoMap, insertRepoMap } from "@agentfactory/db";
import type { SandboxProvider } from "./sandbox/types";
import { cloneIntoSandbox, resolveCloneTarget, resolveDefaultBranchSha } from "./scm-provider";

const RESULT_MARKER = "__RESULT__";

interface GeneratedMap {
  text: string;
  costUsd: number;
  tokens: number;
}

async function execToString(sandboxProvider: SandboxProvider, sandboxId: string, cmd: string[]): Promise<string> {
  let stdout = "";
  for await (const chunk of sandboxProvider.exec(sandboxId, cmd)) {
    if (chunk.stream === "stdout") stdout += chunk.data;
  }
  return stdout;
}

async function getSandboxHeadSha(sandboxProvider: SandboxProvider, sandboxId: string): Promise<string> {
  const stdout = await execToString(sandboxProvider, sandboxId, ["git", "-C", "/workspace", "rev-parse", "HEAD"]);
  return stdout.trim();
}

// Runs the one-shot generation turn (apps/worker/sandbox-image/generate-repo-map.ts) in the
// sandbox that already has the repo checked out. Returns undefined on any failure — caller
// treats that identically to "no map available", never throws further up.
async function generateRepoMap(sandboxProvider: SandboxProvider, sandboxId: string): Promise<GeneratedMap | undefined> {
  try {
    const stdout = await execToString(sandboxProvider, sandboxId, [
      "/agent/node_modules/.bin/tsx",
      "/agent/generate-repo-map.ts",
    ]);
    const resultLine = stdout.split("\n").find((line) => line.startsWith(RESULT_MARKER));
    if (!resultLine) return undefined;
    return JSON.parse(resultLine.slice(RESULT_MARKER.length)) as GeneratedMap;
  } catch (err) {
    console.error("Repo map generation failed:", err);
    return undefined;
  }
}

// Run-time path: called from the run pipeline right after clone, with a sandbox that already
// has the target repo checked out. Cache key is the exact commit sha being worked on — see
// docs/superpowers/specs/2026-08-23-repo-map-indexing-design.md's "Design decisions" for why
// this (not repoFullName alone, not a merge-base) is the invalidation mechanism. Never throws:
// any failure here falls back to "" (no map), and the run proceeds exactly as it did before
// this feature existed.
export async function ensureRepoMap(
  sandboxProvider: SandboxProvider,
  sandboxId: string,
  orgId: number,
  repoFullName: string,
): Promise<string> {
  try {
    const sha = await getSandboxHeadSha(sandboxProvider, sandboxId);
    const cached = await getRepoMap(orgId, repoFullName, sha);
    if (cached) return cached.content;

    const generated = await generateRepoMap(sandboxProvider, sandboxId);
    if (!generated) return "";

    await insertRepoMap({
      orgId,
      repoFullName,
      commitSha: sha,
      content: generated.text,
      generationCostUsd: generated.costUsd,
      generationTokens: generated.tokens,
    });
    return generated.text;
  } catch (err) {
    console.error("Repo map operation failed:", err);
    return "";
  }
}

// Pre-warm path: called when an agent's or team's defaultCodebase is set (apps/web's agent/team
// routes enqueue this via @agentfactory/queue's repo-map-warm queue). Resolves the default
// branch's current sha via the GitHub API alone first — no sandbox needed at all when that
// commit is already cached. On a miss, provisions a throwaway sandbox solely for this job and
// always tears it down, even when clone or generation fails partway through, so a failure here
// never leaks a container. Best-effort like ensureRepoMap: never throws, since a failed warm job
// just means the first real run pays the generation cost, exactly as if this feature didn't run.
export async function warmRepoMap(
  sandboxProvider: SandboxProvider,
  orgId: number,
  repoFullName: string,
  sandboxImage: string,
): Promise<void> {
  try {
    const sha = await resolveDefaultBranchSha(orgId, repoFullName);
    if (!sha) return;
    if (await getRepoMap(orgId, repoFullName, sha)) return;

    const workspace = await resolveCloneTarget(orgId, repoFullName, "main");
    if (!workspace) return;

    const sandbox = await sandboxProvider.create({ image: sandboxImage, env: {} });
    try {
      await cloneIntoSandbox(sandboxProvider, sandbox.id, workspace);
      await ensureRepoMap(sandboxProvider, sandbox.id, orgId, repoFullName);
    } finally {
      await sandboxProvider.destroy(sandbox.id).catch((err) => {
        console.error(`Failed to tear down warm sandbox ${sandbox.id} for ${repoFullName}:`, err);
      });
    }
  } catch (err) {
    console.error(`Repo map pre-warm failed for ${repoFullName}:`, err);
  }
}
