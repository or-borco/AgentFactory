import { expect, test } from "./fixtures";

// Same environment note as context-documents.spec.ts and run-context.spec.ts: for a local run,
// export the scratch test database first (set -a && . ./.env.test.local && set +a &&
// pnpm test:e2e); CI already does. No worker runs during e2e, so an uploaded document can never
// leave "pending" ("Queued") here — which is exactly what these specs assert.

test("creating a task with an attachment shows it as pending, and a failed attachment doesn't block navigation", async ({
  page,
  registeredUser,
}) => {
  await page.goto("/tasks/new");
  await page.getByPlaceholder("e.g. Add dark mode to the design system").fill("Ship the new onboarding flow");

  // Two files staged in one selection: a good one that should end up attached to the task, and
  // an oversized one the task-scoped route will reject with 413 after the task itself exists.
  await page.getByLabel("Attach context documents").setInputFiles([
    { name: "runbook.md", mimeType: "text/markdown", buffer: Buffer.from("# Runbook\n\nDeploy steps.\n") },
    { name: "huge.md", mimeType: "text/markdown", buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61) },
  ]);

  await page.getByRole("button", { name: "Create task" }).click();

  // The task is created and navigation happens regardless of the oversized file's eventual
  // failure — creation must never be blocked by a staged upload.
  await page.waitForURL(/\/tasks\/\d+$/);

  // The failed file is named in a toast, not swallowed silently.
  await expect(page.getByText(/Couldn't attach huge\.md/)).toBeVisible();

  await page.getByRole("button", { name: "Context" }).click();
  await expect(page.getByText("runbook.md")).toBeVisible();
  await expect(page.getByText("Queued")).toBeVisible();
});

test("the task detail Context tab lets a user add and delete a task document after creation", async ({
  page,
  registeredUser,
}) => {
  const taskRes = await page.request.post("/api/tasks", { data: { title: "Doc management task" } });
  expect(taskRes.ok()).toBeTruthy();
  const task = await taskRes.json();

  await page.goto(`/tasks/${task.id}`);
  // The Context tab is reachable even though this task has never had a session/run — task
  // document management doesn't depend on one.
  await page.getByRole("button", { name: "Context" }).click();
  await expect(page.getByText("No documents yet")).toBeVisible();

  await page.getByLabel("Upload document").setInputFiles({
    name: "handbook.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Handbook\n\nOnboarding notes.\n"),
  });

  await expect(page.getByText("handbook.md")).toBeVisible();
  await expect(page.getByText("Queued")).toBeVisible();

  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No documents yet")).toBeVisible();
});
