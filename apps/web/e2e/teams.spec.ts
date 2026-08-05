import { expect, test } from "./fixtures";

test("legacy /teams page shows migration notice and CTA navigates to /teams-v2", async ({ page, registeredUser }) => {
  await page.goto("/teams");

  await expect(page.getByRole("heading", { name: "Teams have moved" })).toBeVisible();
  await expect(page.getByText("Team management has moved to the new Teams page.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to Teams" })).toBeVisible();

  await page.getByRole("button", { name: "Go to Teams" }).click();
  await expect(page).toHaveURL(/\/teams-v2$/);
});
