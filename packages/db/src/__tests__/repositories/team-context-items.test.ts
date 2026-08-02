import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { teams } from "../../schema.js";
import {
  createTeamContextItem,
  deleteTeamContextItem,
  deleteTeamContextItemForOrg,
  listTeamContextItems,
} from "../../repositories/team-context-items.js";
import { insertOrg, insertTeam } from "../fixtures.js";

describe("team-context-items repository", () => {
  it("creates and lists items for a team", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);

    await createTeamContextItem(team.id, "Engineering handbook", 18200);
    await createTeamContextItem(team.id, "API design guidelines", 9400);

    const items = await listTeamContextItems(team.id);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Engineering handbook");
    expect(items[0].sizeBytes).toBe(18200);
    expect(items[1].title).toBe("API design guidelines");
  });

  it("returns empty list for a team with no items", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);

    await expect(listTeamContextItems(team.id)).resolves.toEqual([]);
  });

  it("isolates items by team", async () => {
    const org = await insertOrg();
    const team1 = await insertTeam(org.id);
    const team2 = await insertTeam(org.id);

    await createTeamContextItem(team1.id, "Team 1 doc");
    await createTeamContextItem(team2.id, "Team 2 doc");

    const items = await listTeamContextItems(team1.id);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Team 1 doc");
  });

  it("defaults sizeBytes to 0", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);

    const item = await createTeamContextItem(team.id, "Untitled");
    expect(item.sizeBytes).toBe(0);
  });

  it("deletes an item by id", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    const item = await createTeamContextItem(team.id, "To delete");

    await deleteTeamContextItem(item.id);

    await expect(listTeamContextItems(team.id)).resolves.toEqual([]);
  });

  it("deleteTeamContextItemForOrg returns true and removes the item when org matches", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    const item = await createTeamContextItem(team.id, "Org-scoped doc");

    const result = await deleteTeamContextItemForOrg(item.id, org.id);

    expect(result).toBe(true);
    await expect(listTeamContextItems(team.id)).resolves.toEqual([]);
  });

  it("deleteTeamContextItemForOrg returns false and leaves the item when org does not match", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    const team = await insertTeam(org1.id);
    const item = await createTeamContextItem(team.id, "Cross-org doc");

    const result = await deleteTeamContextItemForOrg(item.id, org2.id);

    expect(result).toBe(false);
    const remaining = await listTeamContextItems(team.id);
    expect(remaining).toHaveLength(1);
  });

  it("cascade-deletes items when the team is deleted", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    await createTeamContextItem(team.id, "Will cascade");

    await db.delete(teams).where(eq(teams.id, team.id));

    await expect(listTeamContextItems(team.id)).resolves.toEqual([]);
  });
});
