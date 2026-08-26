import { expect, test } from "./fixtures";

// Same environment note as run-context.spec.ts: for a local run, export the scratch test
// database first (set -a && . ./.env.test.local && set +a && pnpm test:e2e); CI already does.
//
// No worker runs during e2e, so a run can never reach a terminal status here. The honest
// end-to-end assertions are therefore: the POST route's terminal-status guard answers 409,
// the Evaluation tab renders the GET route's real (empty) answer through the auth gate, and
// the button is disabled with its stated reason while the run is active. The full card state
// machine is covered by RunEvalPanel's component tests with the API mocked, and the judge
// itself is deliberately never exercised in CI (grading quality is not asserted, per spec).
test("the Evaluation tab renders and the eval routes answer", async ({ page, registeredUser }) => {
  const agentRes = await page.request.post("/api/agents", {
    data: { name: "Eval bot", description: "", systemPrompt: "Do eval work.", mode: "manual" },
  });
  expect(agentRes.ok()).toBeTruthy();
  const agent = await agentRes.json();

  const taskRes = await page.request.post("/api/tasks", {
    data: { title: "Eval tab task", assigneeAgentId: agent.id },
  });
  expect(taskRes.ok()).toBeTruthy();
  const task = await taskRes.json();

  // Creates the session and its first (queued) run; the response carries runId.
  const runRes = await page.request.post(`/api/tasks/${task.id}/run`);
  expect(runRes.ok()).toBeTruthy();
  const { runId } = await runRes.json();

  // The POST guard end to end: a queued run is not evaluable.
  const evalRes = await page.request.post(`/api/runs/${runId}/evals`);
  expect(evalRes.status()).toBe(409);

  await page.goto(`/tasks/${task.id}`);

  const listResponse = page.waitForResponse(
    (res) => /\/api\/runs\/\d+\/evals$/.test(res.url()) && res.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Evaluation" }).click();

  const response = await listResponse;
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual([]);

  await expect(page.getByRole("button", { name: "Evaluate", exact: true })).toBeDisabled();
  await expect(page.getByText("Available once the run finishes")).toBeVisible();
});
