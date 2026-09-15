import { expect, test } from "./fixtures";

test.describe("theme toggle", () => {
  test("toggling the theme switches the app's colors and persists across a reload", async ({
    page,
    registeredUser,
  }) => {
    await page.goto("/tasks");

    const html = page.locator("html");
    const toggle = page.locator('[title="Toggle theme"]');
    await expect(toggle).toBeVisible();

    // Starts in the default (dark) theme.
    await expect(html).not.toHaveAttribute("data-theme", "light");
    const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await toggle.click();

    await expect(html).toHaveAttribute("data-theme", "light");
    const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bgAfter).not.toBe(bgBefore);

    // Persists across a reload — the theme is picked up from localStorage before first paint.
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bgAfter);

    // Toggling back switches away from light again.
    await toggle.click();
    await expect(html).not.toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bgBefore);
  });
});
