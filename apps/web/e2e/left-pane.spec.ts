import { expect, test } from "./fixtures";

// ── Left pane nav labels ─────────────────────────────────────────────────────

test("left-hand side menu shows the renamed Tasks nav item", async ({ page, registeredUser }) => {
  await page.goto("/tasks");

  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link", { name: "taskzzz" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Tasks", exact: true })).toHaveCount(0);
});
