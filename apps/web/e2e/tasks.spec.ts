import { expect, test } from "./fixtures";

// ── Tasks list header button (redundant with empty-state CTA) ───────────────

test("empty state hides the redundant top New task button, keeping only the empty-state CTA", async ({
  page,
  registeredUser,
}) => {
  await page.goto("/tasks");

  await expect(page.getByText("No tasks yet")).toBeVisible();

  // Only the empty-state's own "New task" button should render — the top-right
  // header button would be redundant while the list is empty.
  await expect(page.getByRole("button", { name: "New task" })).toHaveCount(1);
});

test("top New task button reappears once the list has tasks", async ({ page, registeredUser }) => {
  await page.request.post("/api/tasks", { data: { title: "First task" } });

  await page.goto("/tasks");

  await expect(page.getByText("No tasks yet")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toHaveCount(1);
});

// ── Task detail layout (issue #32) ───────────────────────────────────────────

test("task detail shows split-pane layout with reply bar always visible", async ({ page, registeredUser }) => {
  const res = await page.request.post("/api/tasks", {
    data: { title: "Layout test task", description: "Verify split-pane layout." },
  });
  const task = await res.json();
  await page.goto(`/tasks/${task.id}`);

  // Left pane: breadcrumb back-link
  await expect(page.getByRole("link", { name: /← Tasks/i })).toBeVisible();

  // Right pane: Transcript tab
  await expect(page.getByRole("button", { name: "Transcript" })).toBeVisible();

  // Reply bar is always rendered, even without a session
  await expect(page.getByPlaceholder(/Reply to the agent/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("reply bar is disabled when task has no active session", async ({ page, registeredUser }) => {
  const res = await page.request.post("/api/tasks", { data: { title: "No-session task" } });
  const task = await res.json();
  await page.goto(`/tasks/${task.id}`);

  const textarea = page.getByPlaceholder(/Reply to the agent/);
  const sendBtn = page.getByRole("button", { name: "Send" });

  await expect(textarea).toBeDisabled();
  await expect(sendBtn).toBeDisabled();
});

test("collapse handle toggles the left pane", async ({ page, registeredUser }) => {
  const res = await page.request.post("/api/tasks", { data: { title: "Collapse test task" } });
  const task = await res.json();
  await page.goto(`/tasks/${task.id}`);

  // Breadcrumb is visible in the expanded state
  await expect(page.getByRole("link", { name: /← Tasks/i })).toBeVisible();

  // Collapse the panel
  await page.getByTitle("Collapse panel").click();

  // Breadcrumb content is now hidden (pointer-events:none + opacity:0)
  await expect(page.getByRole("link", { name: /← Tasks/i })).not.toBeVisible();

  // Expand it back
  await page.getByTitle("Expand panel").click();
  await expect(page.getByRole("link", { name: /← Tasks/i })).toBeVisible();
});

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

// ── Assigning an agent after task creation ───────────────────────────────────

test("assigning an agent to an unassigned task flips it to Assigned and reveals Run agent", async ({
  page,
  registeredUser,
}) => {
  const agentRes = await page.request.post("/api/agents", {
    data: { name: "QA bot", description: "", systemPrompt: "Do QA work.", mode: "manual" },
  });
  const agent = await agentRes.json();

  const taskRes = await page.request.post("/api/tasks", { data: { title: "Unassigned task" } });
  const task = await taskRes.json();

  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run agent" })).not.toBeVisible();

  await page.getByRole("combobox", { name: "Assignee" }).selectOption(String(agent.id));

  await expect(page.getByText("Assigned", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run agent" })).toBeVisible();

  // Persists across reload, not just local component state.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Assignee" })).toHaveValue(String(agent.id));
  await expect(page.getByText("Assigned", { exact: true })).toBeVisible();
});

test("the assignee field is read-only once a task has an active session", async ({ page, registeredUser }) => {
  const agentRes = await page.request.post("/api/agents", {
    data: { name: "QA bot", description: "", systemPrompt: "Do QA work.", mode: "manual" },
  });
  const agent = await agentRes.json();

  const taskRes = await page.request.post("/api/tasks", {
    data: { title: "Already running task", assigneeAgentId: agent.id },
  });
  const task = await taskRes.json();

  const runRes = await page.request.post(`/api/tasks/${task.id}/run`);
  expect(runRes.ok()).toBeTruthy();

  await page.goto(`/tasks/${task.id}`);

  await expect(page.getByRole("combobox", { name: "Assignee" })).not.toBeVisible();
  await expect(page.getByText("QA bot", { exact: true })).toBeVisible();
});
