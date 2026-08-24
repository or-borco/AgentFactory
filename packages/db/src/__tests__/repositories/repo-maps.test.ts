import { describe, expect, it } from "vitest";
import "../setup.js";
import { getRepoMap, insertRepoMap } from "../../repositories/repo-maps.js";
import { insertOrg } from "../fixtures.js";

describe("repo-maps repository", () => {
  it("returns undefined when no map is cached for a commit", async () => {
    const org = await insertOrg();
    await expect(getRepoMap(org.id, "acme/widgets", "deadbeef")).resolves.toBeUndefined();
  });

  it("inserts and fetches a map by (org, repo, commit sha)", async () => {
    const org = await insertOrg();
    await insertRepoMap({
      orgId: org.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "# Repo map\n\nUse pnpm.",
      generationCostUsd: 0.002,
      generationTokens: 1500,
    });

    const map = await getRepoMap(org.id, "acme/widgets", "abc123");
    expect(map).toMatchObject({
      orgId: org.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "# Repo map\n\nUse pnpm.",
      generationCostUsd: 0.002,
      generationTokens: 1500,
    });
  });

  it("truncates content to 16384 characters before storing", async () => {
    const org = await insertOrg();
    const oversized = "a".repeat(20_000);

    await insertRepoMap({
      orgId: org.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: oversized,
      generationCostUsd: 0,
      generationTokens: 0,
    });

    const map = await getRepoMap(org.id, "acme/widgets", "abc123");
    expect(map!.content).toHaveLength(16384);
  });

  it("does not fail on a concurrent insert for the same (org, repo, commit sha) — only one row survives", async () => {
    const org = await insertOrg();
    const input = {
      orgId: org.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "first",
      generationCostUsd: 0,
      generationTokens: 0,
    };

    await insertRepoMap(input);
    await insertRepoMap({ ...input, content: "second" }); // loses the race, no-ops

    const map = await getRepoMap(org.id, "acme/widgets", "abc123");
    expect(map!.content).toBe("first");
  });

  it("scopes lookups by orgId — a map for one org is invisible to another", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    await insertRepoMap({
      orgId: org1.id,
      repoFullName: "acme/widgets",
      commitSha: "abc123",
      content: "org1 map",
      generationCostUsd: 0,
      generationTokens: 0,
    });

    await expect(getRepoMap(org2.id, "acme/widgets", "abc123")).resolves.toBeUndefined();
  });
});
