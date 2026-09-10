import { describe, expect, it } from "vitest";
import "../setup.js";
import { assignSkillToAgent, listAgentSkills, listSkillAssignments, unassignSkillFromAgent, updateAgentSkillVersion } from "../../repositories/agent-skills.js";
import { createDraftFromPublished, createSkillWithDraft, publishDraft } from "../../repositories/skills.js";
import { insertAgent, insertOrg } from "../fixtures.js";

describe("agent-skills repository", () => {
  it("assigns the currently published version", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill, draft } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, draft.id);

    const pin = await assignSkillToAgent(agent.id, skill.id);
    expect(pin?.skillVersionId).toBe(draft.id);

    const listed = await listAgentSkills(agent.id);
    expect(listed).toEqual([expect.objectContaining({ skillId: skill.id, version: 1 })]);
  });

  it("refuses to assign a skill with no published version", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await expect(assignSkillToAgent(agent.id, skill.id)).resolves.toBeUndefined();
  });

  it("upgrade pins a newer published version; rejects an unpublished one", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill, draft: v1 } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, v1.id);
    await assignSkillToAgent(agent.id, skill.id);

    const v2 = await createDraftFromPublished(skill.id, org.id);
    if (!v2) throw new Error("expected a second draft");

    await expect(updateAgentSkillVersion(agent.id, skill.id, v2.id)).resolves.toBeUndefined(); // not published yet

    await publishDraft(skill.id, org.id, v2.id);
    const upgraded = await updateAgentSkillVersion(agent.id, skill.id, v2.id);
    expect(upgraded?.skillVersionId).toBe(v2.id);
  });

  it("listSkillAssignments is the reverse lookup by skill", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id, { name: "Reviewer" });
    const { skill, draft } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, draft.id);
    await assignSkillToAgent(agent.id, skill.id);

    const assignments = await listSkillAssignments(skill.id);
    expect(assignments).toEqual([
      expect.objectContaining({ agentId: agent.id, agentName: "Reviewer", version: 1 }),
    ]);
  });

  it("unassign removes the pin", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill, draft } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, draft.id);
    await assignSkillToAgent(agent.id, skill.id);

    await expect(unassignSkillFromAgent(agent.id, skill.id)).resolves.toBe(true);
    await expect(listAgentSkills(agent.id)).resolves.toEqual([]);
  });
});
