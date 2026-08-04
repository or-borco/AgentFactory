import { expect, test } from "./fixtures";

test("the Agents page shows the migration notice and redirects to Teams on CTA click", async ({ page, registeredUser }) => {
  await page.goto("/agents");

  await expect(page.getByText("Agents have moved")).toBeVisible();
  await expect(page.getByText("Agent management has moved to the Teams page.")).toBeVisible();

  await page.getByRole("button", { name: "Go to Teams" }).click();
  await expect(page).toHaveURL(/\/teams-v2$/);
});
