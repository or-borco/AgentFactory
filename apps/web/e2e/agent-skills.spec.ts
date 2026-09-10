import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures";

// Creates a skill and immediately publishes its v1 draft, returning the resulting Skill
// (with currentVersionId set) so callers can assign/upgrade against it right away.
async function createPublishedSkill(request: APIRequestContext, name: string) {
  const createRes = await request.post("/api/skills", {
    data: { name, description: `${name} description`, instructions: `Follow the ${name} rules.` },
  });
  expect(createRes.status()).toBe(201);
  const { skill } = await createRes.json();

  const publishRes = await request.post(`/api/skills/${skill.id}/draft/publish`);
  expect(publishRes.status()).toBe(200);
  return (await publishRes.json()).skill;
}

async function createAgent(request: APIRequestContext, name: string) {
  const res = await request.post("/api/agents", {
    data: { name, description: "", systemPrompt: "Do the thing.", mode: "manual" },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test("assign, upgrade, and unassign a skill on an agent", async ({ page, registeredUser }) => {
  const skill = await createPublishedSkill(page.request, "Conventional commits");
  const agent = await createAgent(page.request, "Reviewer");

  const assignRes = await page.request.post(`/api/agents/${agent.id}/skills`, {
    data: { skillId: skill.id },
  });
  expect(assignRes.status()).toBe(201);
  const pin = await assignRes.json();
  expect(pin).toMatchObject({ agentId: agent.id, skillId: skill.id, skillVersionId: skill.currentVersionId });

  const listRes = await page.request.get(`/api/agents/${agent.id}/skills`);
  expect(listRes.status()).toBe(200);
  expect(await listRes.json()).toEqual([
    expect.objectContaining({ skillId: skill.id, version: 1, skillName: "Conventional commits" }),
  ]);

  await page.goto(`/agents/${agent.id}`);
  await expect(page.getByText("Conventional commits")).toBeVisible();
  // Scoped to <span> (the Badge element) so this doesn't also match the upgrade <select>'s
  // "v1" <option>, which getByText's broader text search would.
  await expect(page.locator("span", { hasText: /^v1$/ })).toBeVisible();

  // Publish a second version of the same skill; upgrading to it before it's published is
  // rejected, and after publishing it succeeds.
  const versionRes = await page.request.post(`/api/skills/${skill.id}/versions`);
  expect(versionRes.status()).toBe(201);
  const draftV2 = await versionRes.json();

  const upgradeToDraftRes = await page.request.patch(`/api/agents/${agent.id}/skills/${skill.id}`, {
    data: { skillVersionId: draftV2.id },
  });
  expect(upgradeToDraftRes.status()).toBe(400);

  const publishV2Res = await page.request.post(`/api/skills/${skill.id}/draft/publish`);
  expect(publishV2Res.status()).toBe(200);

  const upgradeRes = await page.request.patch(`/api/agents/${agent.id}/skills/${skill.id}`, {
    data: { skillVersionId: draftV2.id },
  });
  expect(upgradeRes.status()).toBe(200);
  expect(await upgradeRes.json()).toMatchObject({ skillVersionId: draftV2.id });

  await page.reload();
  await expect(page.locator("span", { hasText: /^v2$/ })).toBeVisible();

  const removeRes = await page.request.delete(`/api/agents/${agent.id}/skills/${skill.id}`);
  expect(removeRes.status()).toBe(204);
  expect(await (await page.request.get(`/api/agents/${agent.id}/skills`)).json()).toEqual([]);

  await page.reload();
  await expect(page.getByText("No skills assigned yet.")).toBeVisible();
});

test("assigning a skill with no published version is rejected with 400", async ({ page, registeredUser }) => {
  const agent = await createAgent(page.request, "Reviewer");
  const createRes = await page.request.post("/api/skills", {
    data: { name: "Unpublished skill", description: "d", instructions: "v1" },
  });
  expect(createRes.status()).toBe(201);
  const { skill } = await createRes.json();

  const assignRes = await page.request.post(`/api/agents/${agent.id}/skills`, { data: { skillId: skill.id } });
  expect(assignRes.status()).toBe(400);

  expect(await (await page.request.get(`/api/agents/${agent.id}/skills`)).json()).toEqual([]);
});

test("upgrading to a published version of a different skill is rejected with 400", async ({
  page,
  registeredUser,
}) => {
  const agent = await createAgent(page.request, "Reviewer");
  const skillA = await createPublishedSkill(page.request, "Skill A");
  const skillB = await createPublishedSkill(page.request, "Skill B");
  await page.request.post(`/api/agents/${agent.id}/skills`, { data: { skillId: skillA.id } });

  const upgradeRes = await page.request.patch(`/api/agents/${agent.id}/skills/${skillA.id}`, {
    data: { skillVersionId: skillB.currentVersionId },
  });
  expect(upgradeRes.status()).toBe(400);

  const listed = await (await page.request.get(`/api/agents/${agent.id}/skills`)).json();
  expect(listed).toEqual([expect.objectContaining({ skillId: skillA.id, skillVersionId: skillA.currentVersionId })]);
});

test("another org's agent and skill are not readable or writable through these routes", async ({
  page,
  browser,
  registeredUser,
}) => {
  const skill = await createPublishedSkill(page.request, "Owner skill");
  const agent = await createAgent(page.request, "Owner agent");
  await page.request.post(`/api/agents/${agent.id}/skills`, { data: { skillId: skill.id } });

  // A second, fully separate org — its own context so its session cookie doesn't replace the
  // first user's.
  const outsider = await browser.newContext();
  const registerRes = await outsider.request.post("/api/auth/register", {
    data: { name: "E2E outsider", email: `e2e-outsider-${Date.now()}@example.com`, password: "password123" },
  });
  expect(registerRes.ok()).toBeTruthy();

  expect((await outsider.request.get(`/api/agents/${agent.id}/skills`)).status()).toBe(404);
  expect(
    (await outsider.request.post(`/api/agents/${agent.id}/skills`, { data: { skillId: skill.id } })).status(),
  ).toBe(404);
  expect(
    (
      await outsider.request.patch(`/api/agents/${agent.id}/skills/${skill.id}`, {
        data: { skillVersionId: skill.currentVersionId },
      })
    ).status(),
  ).toBe(404);
  expect((await outsider.request.delete(`/api/agents/${agent.id}/skills/${skill.id}`)).status()).toBe(404);

  // Cross-org skill id: the outsider's own agent must not be able to pin the owner's skill either.
  const outsiderAgent = await createAgent(outsider.request, "Outsider agent");
  expect(
    (
      await outsider.request.post(`/api/agents/${outsiderAgent.id}/skills`, { data: { skillId: skill.id } })
    ).status(),
  ).toBe(404);

  await outsider.close();

  // The owner's assignment is untouched by all of the above.
  const listRes = await page.request.get(`/api/agents/${agent.id}/skills`);
  expect(await listRes.json()).toHaveLength(1);
});
