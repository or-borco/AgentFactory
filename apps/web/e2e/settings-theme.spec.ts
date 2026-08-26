import { expect, test, uniqueSuffix } from "./fixtures";

// Mirrors playwright.config.ts's PORT — a manually created `browser.newContext()` (used below to
// simulate a second, independently-authenticated user) doesn't inherit the project's
// `use.baseURL` the way the `page`/`page.request` fixtures do, so it needs to be told explicitly.
const BASE_URL = "http://localhost:3100";

test.describe("theme preference", () => {
  test("defaults to dark for a newly registered user", async ({ page, registeredUser }) => {
    await page.goto("/settings");

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "false");
  });

  test("switching to Light updates the page immediately and survives a reload", async ({ page, registeredUser }) => {
    await page.goto("/settings");

    await page.getByRole("radio", { name: "Light" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");

    // A reload re-renders the root layout from scratch, reading the user's row back out of
    // Postgres (see apps/web/src/app/layout.tsx) — this is what actually proves the preference
    // was persisted server-side rather than only held in the client's React state.
    await page.reload();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  });

  test("persists when navigating to a different page", async ({ page, registeredUser }) => {
    await page.goto("/settings");
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await page.goto("/tasks");

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("is saved per user — switching one account to light leaves another on dark", async ({
    page,
    registeredUser,
    browser,
  }) => {
    await page.goto("/settings");
    await page.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const otherContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      const otherPage = await otherContext.newPage();
      const suffix = uniqueSuffix();
      const otherUser = { name: "E2E Other", email: `e2e-theme-other-${suffix}@example.com`, password: "password123" };
      const res = await otherPage.request.post("/api/auth/register", { data: otherUser });
      if (!res.ok()) {
        throw new Error(`Failed to register second user: ${res.status()} ${await res.text()}`);
      }

      await otherPage.goto("/settings");

      await expect(otherPage.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(otherPage.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    } finally {
      await otherContext.close();
    }

    // The first user's own session is unaffected by the second user's (default) preference.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});
