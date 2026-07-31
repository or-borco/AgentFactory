import { expect, test } from "./fixtures";

test("creates a team and assigns an existing agent to it", async ({ page, registeredUser }) => {
  // The agent under assignment isn't the flow under test here, so create it via the API
  // directly rather than through the New Agent modal (already covered by agents.spec.ts).
  const agentRes = await page.request.post("/api/agents", {
    data: {
      name: "Support Bot",
      description: "Handles support tickets",
      systemPrompt: "Help users with their questions.",
      mode: "manual",
    },
  });
  const agent = await agentRes.json();

  await page.goto("/teams");
  // A brand-new org has zero teams, so the empty-state view renders its own "New team" button
  // in addition to the page header's — both visible, hence `.first()`.
  await page.getByRole("button", { name: "New team" }).first().click();
  await page.getByPlaceholder("e.g. Platform team").fill("QA Team");
  await page.getByPlaceholder("Optional").fill("Owns test coverage");
  await page.getByRole("button", { name: "Create team" }).click();

  await expect(page).toHaveURL(/\/teams\/\d+$/);
  await expect(page.getByRole("heading", { name: "QA Team" })).toBeVisible();
  await expect(page.getByText("No agents assigned to this team yet.")).toBeVisible();

  await page.getByRole("combobox").selectOption({ label: agent.name });
  await page.getByRole("button", { name: "Assign" }).click();

  await expect(page.getByText(agent.name)).toBeVisible();
  await expect(page.getByText("No agents assigned to this team yet.")).not.toBeVisible();

  // Persists: reloading the team page still shows the assignment.
  await page.reload();
  await expect(page.getByText(agent.name)).toBeVisible();
});
