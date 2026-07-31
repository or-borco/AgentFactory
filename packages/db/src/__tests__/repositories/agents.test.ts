import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { teams } from "../../schema.js";
import { createAgent, getAgent, listAgents, updateAgent } from "../../repositories/agents.js";
import { insertAgent, insertOrg, insertTeam } from "../fixtures.js";

describe("agents repository", () => {
  it("creates and fetches an agent by id", async () => {
    const org = await insertOrg();
    const agent = await createAgent(org.id, {
      name: "Code reviewer",
      description: "Reviews PRs",
      systemPrompt: "Review the diff.",
      mode: "automatic",
    });
    await expect(getAgent(agent.id)).resolves.toEqual(agent);
  });

  it("lists only agents belonging to the given org", async () => {
    const org1 = await insertOrg();
    const org2 = await insertOrg();
    const agent1 = await insertAgent(org1.id, { name: "Agent A" });
    await insertAgent(org2.id, { name: "Agent B" });

    const agents = await listAgents(org1.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toEqual(agent1);
  });

  it("caps the agent name at 80 characters", async () => {
    const org = await insertOrg();
    const agent = await createAgent(org.id, {
      name: "x".repeat(200),
      description: "",
      systemPrompt: "Be helpful.",
      mode: "manual",
    });
    expect(agent.name).toHaveLength(80);
  });

  it("updates only the provided fields", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id, { name: "Original", mode: "manual" });

    const updated = await updateAgent(agent.id, { mode: "automatic" });

    expect(updated).toMatchObject({ name: "Original", mode: "automatic" });
  });

  it("clears teamId when explicitly patched to undefined", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    const agent = await insertAgent(org.id, { teamId: team.id });

    const updated = await updateAgent(agent.id, { teamId: undefined });

    expect(updated?.teamId).toBeUndefined();
  });

  it("has teamId set to null when its team is deleted", async () => {
    const org = await insertOrg();
    const team = await insertTeam(org.id);
    const agent = await insertAgent(org.id, { teamId: team.id });

    await db.delete(teams).where(eq(teams.id, team.id));

    const reloaded = await getAgent(agent.id);
    expect(reloaded?.teamId).toBeUndefined();
  });
});
