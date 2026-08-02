import { expect, test } from "./fixtures";

test("creates an agent from the Agents page and opens its detail page", async ({ page, registeredUser }) => {
  await page.goto("/agents");

  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByPlaceholder("e.g. Code reviewer").fill("QA Automation Bot");
  await page.getByPlaceholder("One line describing what this agent does").fill("Runs automated quality checks");
  await page
    .getByPlaceholder("Describe the agent's purpose and how it should behave")
    .fill("Review test coverage and flag any gaps.");
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page).toHaveURL(/\/agents\/\d+$/);
  await expect(page.getByRole("heading", { name: "QA Automation Bot" })).toBeVisible();
  await expect(page.getByText("Runs automated quality checks")).toBeVisible();

  // Persists: navigating back to the list still shows it.
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "QA Automation Bot" })).toBeVisible();
});
