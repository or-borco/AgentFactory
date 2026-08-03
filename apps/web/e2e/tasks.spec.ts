import { expect, test } from "./fixtures";

test("shows a link to the opened PR once the task has one", async ({ page, registeredUser }) => {
  const createRes = await page.request.post("/api/tasks", {
    data: { title: "Add dark mode toggle", description: "Add a dark mode toggle to settings." },
  });
  expect(createRes.ok()).toBeTruthy();
  const task = await createRes.json();

  // Simulates what the worker does after successfully pushing and opening a draft PR — this
  // spec verifies the UI renders that state correctly, not the worker/GitHub integration itself
  // (covered by apps/worker's unit tests and manual verification against a real sandbox).
  const patchRes = await page.request.patch(`/api/tasks/${task.id}`, {
    data: { prNumber: 7, prUrl: "https://github.com/acme-org/platform/pull/7", status: "pr_open" },
  });
  expect(patchRes.ok()).toBeTruthy();

  await page.goto(`/tasks/${task.id}`);

  const prLink = page.getByRole("link", { name: "#7 ↗" });
  await expect(prLink).toBeVisible();
  await expect(prLink).toHaveAttribute("href", "https://github.com/acme-org/platform/pull/7");
});

test("shows no PR link for a task that hasn't opened one", async ({ page, registeredUser }) => {
  const createRes = await page.request.post("/api/tasks", { data: { title: "Task without a PR yet" } });
  const task = await createRes.json();

  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByRole("link", { name: /↗/ })).not.toBeVisible();
});
