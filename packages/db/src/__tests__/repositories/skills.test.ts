import { describe, expect, it } from "vitest";
import "../setup.js";
import {
  createDraftFromPublished,
  createSkillWithDraft,
  deleteSkillForOrg,
  getSkillForOrg,
  listSkillsForOrg,
  publishDraft,
} from "../../repositories/skills.js";
import { getDraftForSkill, getSkillVersionMarkdown, updateDraft } from "../../repositories/skill-versions.js";
import { assignSkillToAgent } from "../../repositories/agent-skills.js";
import { insertAgent, insertOrg } from "../fixtures.js";

describe("skills repository", () => {
  it("creates a skill with an unpublished draft", async () => {
    const org = await insertOrg();
    const { skill, draft } = await createSkillWithDraft(org.id, {
      name: "Conventional Commits",
      description: "Validate commit messages",
      instructions: "Follow the spec.",
    });
    expect(skill.currentVersionId).toBeUndefined();
    expect(draft.publishedAt).toBeUndefined();
    expect(draft.version).toBe(1);
    await expect(getSkillForOrg(skill.id, org.id)).resolves.toMatchObject({ id: skill.id });
  });

  it("publishing sets currentVersionId and denormalized name/description", async () => {
    const org = await insertOrg();
    const { skill, draft } = await createSkillWithDraft(org.id, {
      name: "Foo", description: "First", instructions: "Body v1",
    });
    const result = await publishDraft(skill.id, org.id, draft.id);
    expect(result?.skill.currentVersionId).toBe(draft.id);
    expect(result?.version.publishedAt).toBeDefined();

    const listed = await listSkillsForOrg(org.id);
    expect(listed.find((s) => s.id === skill.id)?.currentVersionId).toBe(draft.id);
  });

  it("only one draft can exist per skill at a time", async () => {
    const org = await insertOrg();
    const { skill, draft } = await createSkillWithDraft(org.id, {
      name: "Foo", description: "d", instructions: "v1",
    });
    await publishDraft(skill.id, org.id, draft.id);

    const second = await createDraftFromPublished(skill.id, org.id);
    expect(second?.version).toBe(2);

    const blockedThird = await createDraftFromPublished(skill.id, org.id);
    expect(blockedThird).toBeUndefined();
  });

  it("updateDraft rejects a published version", async () => {
    const org = await insertOrg();
    const { skill, draft } = await createSkillWithDraft(org.id, {
      name: "Foo", description: "d", instructions: "v1",
    });
    await publishDraft(skill.id, org.id, draft.id);
    const result = await updateDraft(draft.id, org.id, { instructions: "changed" });
    expect(result).toBeUndefined();
  });

  it("stores and round-trips the composed SKILL.md body", async () => {
    const org = await insertOrg();
    const { draft } = await createSkillWithDraft(org.id, {
      name: "Foo", description: "A skill", instructions: "Do the thing.",
    });
    const markdown = await getSkillVersionMarkdown(org.id, draft);
    expect(markdown).toContain("name: Foo");
    expect(markdown).toContain("description: A skill");
    expect(markdown).toContain("Do the thing.");
  });

  it("deleteSkillForOrg refuses when an agent is assigned", async () => {
    const org = await insertOrg();
    const agent = await insertAgent(org.id);
    const { skill, draft } = await createSkillWithDraft(org.id, { name: "Foo", description: "d", instructions: "v1" });
    await publishDraft(skill.id, org.id, draft.id);
    await assignSkillToAgent(agent.id, skill.id);

    await expect(deleteSkillForOrg(skill.id, org.id)).resolves.toBe(false);
    await expect(getSkillForOrg(skill.id, org.id)).resolves.toBeDefined();
  });
});
