import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { orgs } from "../../schema.js";
import { createTeam, getTeam, listTeams, updateTeam } from "../../repositories/teams.js";
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
});
