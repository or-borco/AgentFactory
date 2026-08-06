import { expect, test } from "./fixtures";

test.describe("Teams v2 — Agents tab", () => {
  test("shows agents list and detail panel for the first agent", async ({ page, registeredUser }) => {
    const teamRes = await page.request.post("/api/teams", {
      data: { name: "Platform team", description: "" },
    });
    const team = await teamRes.json();

    await page.request.post("/api/agents", {
      data: {
        name: "Code reviewer",
        description: "Reviews PRs",
        systemPrompt: "Review the diff.",
        mode: "automatic",
        teamId: team.id,
      },
    });

    await page.goto("/teams-v2");
    await page.getByRole("button", { name: "Agents" }).click();

    // Agent appears in the list (the list item button contains name + description)
    await expect(page.getByRole("button", { name: /Code reviewer/ })).toBeVisible();

    // Detail panel header shows the agent
    const detailHeader = page.locator(".border-b").filter({ hasText: "Code reviewer" }).last();
    await expect(detailHeader).toBeVisible();

    // System prompt textarea contains the value
    await expect(page.locator("textarea").first()).toHaveValue("Review the diff.");
  });

  test("clicking an agent in the list switches the detail panel", async ({ page, registeredUser }) => {
    const teamRes = await page.request.post("/api/teams", {
      data: { name: "Platform team", description: "" },
    });
    const team = await teamRes.json();

    await page.request.post("/api/agents", {
      data: { name: "Agent Alpha", description: "First", systemPrompt: "Do alpha.", mode: "manual", teamId: team.id },
    });
    await page.request.post("/api/agents", {
      data: { name: "Agent Beta", description: "Second", systemPrompt: "Do beta.", mode: "manual", teamId: team.id },
    });

    await page.goto("/teams-v2");
    await page.getByRole("button", { name: "Agents" }).click();

    await page.getByRole("button", { name: /Agent Beta/ }).click();

    await expect(page.locator("textarea").first()).toHaveValue("Do beta.");
  });

  test("creates a new agent via the + button and selects it", async ({ page, registeredUser }) => {
    const teamRes = await page.request.post("/api/teams", {
      data: { name: "Platform team", description: "" },
    });
    await teamRes.json();

    await page.goto("/teams-v2");
    await page.getByRole("button", { name: "Agents" }).click();

    await page.getByRole("button", { name: "New agent" }).click();

    await page.getByPlaceholder("e.g. Code reviewer").fill("Deployment bot");
    await page.getByPlaceholder("One line describing what this agent does").fill("Handles deploys");
    await page.getByPlaceholder("Describe the agent's purpose and how it should behave").fill("Deploy safely.");

    await page.getByRole("button", { name: "Create agent" }).click();

    // New agent appears in the list
    await expect(page.getByRole("button", { name: /Deployment bot/ })).toBeVisible();
    // Detail panel shows its system prompt
    await expect(page.locator("textarea").first()).toHaveValue("Deploy safely.");

    // Persists on reload
    await page.reload();
    await page.getByRole("button", { name: "Agents" }).click();
    await expect(page.getByRole("button", { name: /Deployment bot/ })).toBeVisible();
  });

  test("saves edits to system prompt and persists on reload", async ({ page, registeredUser }) => {
    const teamRes = await page.request.post("/api/teams", {
      data: { name: "Platform team", description: "" },
    });
    const team = await teamRes.json();

    await page.request.post("/api/agents", {
      data: { name: "Editable bot", description: "", systemPrompt: "Original prompt.", mode: "manual", teamId: team.id },
    });

    await page.goto("/teams-v2");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: /Editable bot/ }).click();

    const textarea = page.locator("textarea").first();
    await textarea.fill("Updated prompt.");
    await expect(textarea).toHaveValue("Updated prompt.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Agent updated")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: /Editable bot/ }).click();

    await expect(page.locator("textarea").first()).toHaveValue("Updated prompt.");
  });

  test("deletes an agent and removes it from the list", async ({ page, registeredUser }) => {
    const teamRes = await page.request.post("/api/teams", {
      data: { name: "Platform team", description: "" },
    });
    const team = await teamRes.json();

    await page.request.post("/api/agents", {
      data: { name: "Doomed bot", description: "", systemPrompt: "Soon gone.", mode: "manual", teamId: team.id },
    });

    await page.goto("/teams-v2");
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("button", { name: /Doomed bot/ }).click();

    await page.getByRole("button", { name: "Delete agent" }).click();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByRole("button", { name: /Doomed bot/ })).not.toBeVisible();
  });
});
