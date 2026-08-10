import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { teams } from "../../schema.js";
import { createAgent, deleteAgent, getAgent, listAgents, updateAgent } from "../../repositories/agents.js";
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

  it("stores and returns areaMap and defaultCodebase", async () => {
    const org = await insertOrg();
    const agent = await createAgent(org.id, {
      name: "Mapper",
      description: "",
      systemPrompt: "Map areas.",
      mode: "manual",
    });

    const areaMap = { "src/auth/": "Auth module", "src/billing/": "Billing module" };
    const updated = await updateAgent(agent.id, { areaMap, defaultCodebase: "acme/backend" });

    expect(updated?.areaMap).toEqual(areaMap);
    expect(updated?.defaultCodebase).toBe("acme/backend");

    const reloaded = await getAgent(agent.id);
    expect(reloaded?.areaMap).toEqual(areaMap);
    expect(reloaded?.defaultCodebase).toBe("acme/backend");
  });

  it("clears areaMap when patched to undefined, and defaultCodebase when patched to empty string", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    await updateAgent(agent.id, { areaMap: { "src/": "All" }, defaultCodebase: "acme/backend" });

    // undefined clears areaMap (stored as null → returned as undefined)
    // empty string clears defaultCodebase (treated as falsy → stored as null → returned as undefined)
    const cleared = await updateAgent(agent.id, { areaMap: undefined, defaultCodebase: "" });

    expect(cleared?.areaMap).toBeUndefined();
    expect(cleared?.defaultCodebase).toBeUndefined();
  });

  it("deletes an agent by id", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);

    await deleteAgent(agent.id);

    await expect(getAgent(agent.id)).resolves.toBeUndefined();
  });

  it("deleteAgent is a no-op for a non-existent id", async () => {
    await expect(deleteAgent(999_999)).resolves.toBeUndefined();
  });

  it("defaults onContextOverflow to fallback", async () => {
    const org = await insertOrg();
    const agent = await createAgent(org.id, {
      name: "Reviewer",
      description: "",
      systemPrompt: "Be helpful.",
      mode: "manual",
    });
    expect(agent.onContextOverflow).toBe("fallback");
  });

  it("accepts an explicit onContextOverflow on create", async () => {
    const org = await insertOrg();
    const agent = await createAgent(org.id, {
      name: "Strict reviewer",
      description: "",
      systemPrompt: "Be helpful.",
      mode: "manual",
      onContextOverflow: "fail_fast",
    });
    expect(agent.onContextOverflow).toBe("fail_fast");
  });

  it("updates onContextOverflow", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);

    const updated = await updateAgent(agent.id, { onContextOverflow: "fail_fast" });

    expect(updated?.onContextOverflow).toBe("fail_fast");
  });
});
