import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import "../setup.js";
import { db } from "../../client.js";
import { teams } from "../../schema.js";
import { createAgent, deleteAgent, duplicateAgent, getAgent, listAgents, updateAgent } from "../../repositories/agents.js";
import { assignSkillToAgent, listAgentSkills } from "../../repositories/agent-skills.js";
import { createSkillWithDraft, publishDraft } from "../../repositories/skills.js";
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

  it("creates an agent with a default codebase", async () => {
    const org = await insertOrg();
    const agent = await createAgent(org.id, {
      name: "Backend agent",
      description: "",
      systemPrompt: "Ship it.",
      mode: "manual",
      defaultCodebase: "acme-corp/backend",
    });

    expect(agent.defaultCodebase).toBe("acme-corp/backend");
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

  describe("duplicateAgent", () => {
    it("copies everything into the target team, prefixing the name", async () => {
      const org = await insertOrg();
      const sourceTeam = await insertTeam(org.id, { name: "Source" });
      const targetTeam = await insertTeam(org.id, { name: "Target" });
      const agent = await createAgent(org.id, {
        name: "Code reviewer",
        description: "Reviews PRs",
        systemPrompt: "Review the diff.",
        mode: "automatic",
        teamId: sourceTeam.id,
        defaultCodebase: "acme/backend",
      });

      const duplicate = await duplicateAgent(agent.id, targetTeam.id);

      expect(duplicate).toMatchObject({
        orgId: org.id,
        teamId: targetTeam.id,
        name: "Copy of Code reviewer",
        description: "Reviews PRs",
        systemPrompt: "Review the diff.",
        mode: "automatic",
        runtimeKind: agent.runtimeKind,
        toolPolicy: agent.toolPolicy,
        connectionIds: agent.connectionIds,
        onContextOverflow: agent.onContextOverflow,
        defaultCodebase: "acme/backend",
      });
      // A genuinely new row, not a mutation of the source.
      expect(duplicate?.id).not.toBe(agent.id);
      await expect(getAgent(agent.id)).resolves.toMatchObject({ teamId: sourceTeam.id, name: "Code reviewer" });
    });

    it("caps the 'Copy of' name at 80 characters", async () => {
      const org = await insertOrg();
      const team = await insertTeam(org.id);
      const agent = await createAgent(org.id, {
        name: "x".repeat(80),
        description: "",
        systemPrompt: "Be helpful.",
        mode: "manual",
      });

      const duplicate = await duplicateAgent(agent.id, team.id);

      expect(duplicate?.name).toHaveLength(80);
      expect(duplicate?.name.startsWith("Copy of ")).toBe(true);
    });

    it("copies pinned skill versions to the duplicate", async () => {
      const org = await insertOrg();
      const team = await insertTeam(org.id);
      const agent = await insertAgent(org.id);
      const { skill, draft } = await createSkillWithDraft(org.id, {
        name: "Foo",
        description: "d",
        instructions: "v1",
      });
      await publishDraft(skill.id, org.id, draft.id);
      await assignSkillToAgent(agent.id, skill.id);

      const duplicate = await duplicateAgent(agent.id, team.id);
      if (!duplicate) throw new Error("expected a duplicate");

      const duplicatedSkills = await listAgentSkills(duplicate.id);
      expect(duplicatedSkills).toEqual([
        expect.objectContaining({ skillId: skill.id, skillVersionId: draft.id }),
      ]);
    });

    it("returns undefined for a non-existent source agent", async () => {
      const org = await insertOrg();
      const team = await insertTeam(org.id);
      await expect(duplicateAgent(999_999, team.id)).resolves.toBeUndefined();
    });
  });
});
