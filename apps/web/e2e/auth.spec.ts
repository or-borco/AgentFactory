import { expect, test, uniqueSuffix } from "./fixtures";

test.describe("authentication", () => {
  test("visiting a protected route while logged out redirects to /login", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("signing up creates an account and lands on the Tasks page", async ({ page }) => {
    const suffix = uniqueSuffix();
    await page.goto("/register");

    await page.getByPlaceholder("Ada Lovelace").fill(`E2E Signup ${suffix}`);
    await page.getByPlaceholder("you@example.com").fill(`e2e-signup-${suffix}@example.com`);
    await page.getByPlaceholder("••••••••").first().fill("password123");
    await page.getByPlaceholder("••••••••").last().fill("password123");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/tasks$/);
  });

  test("logging out redirects to /login and clears the session", async ({ page, registeredUser }) => {
    await page.goto("/tasks");
    await expect(page).toHaveURL(/\/tasks$/);

    await page.locator('[title="Log out"]').click();

    await expect(page).toHaveURL(/\/login$/);
    // The session cookie is gone, so a fresh visit to a protected route redirects again.
    await page.goto("/tasks");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("logging in with valid credentials redirects to Tasks", async ({ page, registeredUser }) => {
    await page.context().clearCookies();
    await page.goto("/login");

    await page.getByPlaceholder("you@example.com").fill(registeredUser.email);
    await page.getByPlaceholder("••••••••").fill(registeredUser.password);
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL(/\/tasks$/);
  });

  test("logging in with the wrong password shows an error and stays on /login", async ({ page, registeredUser }) => {
    await page.context().clearCookies();
    await page.goto("/login");

    await page.getByPlaceholder("you@example.com").fill(registeredUser.email);
    await page.getByPlaceholder("••••••••").fill("wrong-password");
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page.getByText("Invalid email or password")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
