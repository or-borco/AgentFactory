import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { orgs } from "../../schema.js";
import { createTeam, getTeam, getTeamForOrg, listTeams, updateTeam } from "../../repositories/teams.js";
import { insertOrg, insertTeam } from "../fixtures.js";

describe("teams repository", () => {
  it("creates and fetches a team by id", async () => {
    const org = await insertOrg();
    const team = await createTeam(org.id, "Platform", "Core services");
    await expect(getTeam(team.id)).resolves.toEqual(team);
  });

  it("lists only teams belonging to the given org", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    const team1 = await insertTeam(org1.id, { name: "Team A" });
    await insertTeam(org2.id, { name: "Team B" });

    const teams = await listTeams(org1.id);
    expect(teams).toHaveLength(1);
    expect(teams[0]).toEqual(team1);
  });

  it("caps the team name at 80 characters", async () => {
    const org = await insertOrg();
    const team = await createTeam(org.id, "x".repeat(200), "");
    expect(team.name).toHaveLength(80);
  });

  it("caps sharedContext at 64KB when updated", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    const oversized = "a".repeat(70_000);

    const updated = await updateTeam(team.id, { sharedContext: oversized });

    expect(new TextEncoder().encode(updated!.sharedContext).length).toBe(64 * 1024);
  });

  it("updates only the provided fields", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id, { name: "Original", description: "Original desc" });

    const updated = await updateTeam(team.id, { description: "New desc" });

    expect(updated).toMatchObject({ name: "Original", description: "New desc" });
  });

  it("is deleted when its org is deleted", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);

    await db.delete(orgs).where(eq(orgs.id, org.id));

    await expect(getTeam(team.id)).resolves.toBeUndefined();
  });

  it("stores and returns defaultCodebase, and clears it when patched to empty string", async () => {
    const org = await insertOrg();
    const team = await createTeam(org.id, "Platform", "", "acme-corp/backend");
    expect(team.defaultCodebase).toBe("acme-corp/backend");

    const updated = await updateTeam(team.id, { defaultCodebase: "acme-corp/frontend" });
    expect(updated?.defaultCodebase).toBe("acme-corp/frontend");

    const cleared = await updateTeam(team.id, { defaultCodebase: "" });
    expect(cleared?.defaultCodebase).toBeUndefined();
  });

  it("getTeamForOrg returns the team when the org matches", async () => {
    const org = await insertOrg();
    const team = await createTeam(org.id, "Platform", "Core services");
    await expect(getTeamForOrg(team.id, org.id)).resolves.toEqual(team);
  });

  // agents.team_id is settable across orgs today (PATCH /api/agents/[agentId] is unscoped by
  // acknowledged design debt), so this is the state an attacker can actually reach. getTeam
  // hands back the other org's team; getTeamForOrg is what closes it.
  it("getTeamForOrg returns undefined for a team in another org, where getTeam does not", async () => {
    const orgA = await insertOrg();
    const orgB = await insertOrg();
    const teamB = await insertTeam(orgB.id, { name: "Org B team" });

    await expect(getTeam(teamB.id)).resolves.toBeDefined();
    await expect(getTeamForOrg(teamB.id, orgA.id)).resolves.toBeUndefined();
  });

  it("getTeamForOrg returns undefined for a team id that does not exist", async () => {
    const org = await insertOrg();
    await expect(getTeamForOrg(999_999, org.id)).resolves.toBeUndefined();
  });
});
