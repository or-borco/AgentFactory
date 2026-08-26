import { expect, test } from "./fixtures";

// Local run: the Playwright webServer starts `next dev`, which falls back to apps/web/.env.local
// — the developer's MAIN dev database, which does not have migration 0014 and would 500 this
// route. Export the scratch test database first so `next dev` inherits it (Next does not override
// variables already in process.env):
//
//   set -a && . ./.env.test.local && set +a && pnpm test:e2e
//
// In CI the job already exports DATABASE_URL for the scratch database (.github/workflows/test.yml)
// and migrates it, so `pnpm test:e2e` is correct there as-is.

// The Context tab is the only consumer of GET /api/runs/:runId/prompt, so this spec is what
// exercises that route end to end: the auth gate (via the registeredUser fixture's cookie),
// the real handler and its DB read, the client fetch, and the tab's rendering of the answer.
//
// The run created here is queued and has never been picked up by a worker, so it has no stored
// segments — the assertion is the honest null state, which is the response this route returns
// for every run whose prompt was not recorded.
test("the Context tab renders the run prompt endpoint's answer", async ({ page, registeredUser }) => {
  const agentRes = await page.request.post("/api/agents", {
    data: { name: "Context bot", description: "", systemPrompt: "Do context work.", mode: "manual" },
  });
  expect(agentRes.ok()).toBeTruthy();
  const agent = await agentRes.json();

  const taskRes = await page.request.post("/api/tasks", {
    data: { title: "Context tab task", assigneeAgentId: agent.id },
  });
  expect(taskRes.ok()).toBeTruthy();
  const task = await taskRes.json();

  // Creates the session and its first run — the Context tab only appears once a session exists.
  const runRes = await page.request.post(`/api/tasks/${task.id}/run`);
  expect(runRes.ok()).toBeTruthy();

  await page.goto(`/tasks/${task.id}`);

  const promptResponse = page.waitForResponse(
    (res) => /\/api\/runs\/\d+\/prompt$/.test(res.url()) && res.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Context" }).click();

  // The route answered on its own — not a 401 from the auth gate, not a 500 from the DB read.
  const response = await promptResponse;
  expect(response.status()).toBe(200);

  await expect(page.getByText(/No prompt was recorded for this run/)).toBeVisible();
});
