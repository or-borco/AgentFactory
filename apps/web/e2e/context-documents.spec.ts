import { expect, test } from "./fixtures";

// Same environment note as run-context.spec.ts: for a local run, export the scratch test
// database first (set -a && . ./.env.test.local && set +a && pnpm test:e2e); CI already does.
//
// No worker runs during e2e, so an uploaded document can never leave "pending" here — which is
// exactly what this asserts. The header-less Content-Length case is unreachable from Playwright
// (page.request always sends an honest header) and lives in the route's unit test instead.
test("a document uploads, appears as pending, and can't be uploaded twice", async ({
  page,
  registeredUser,
}) => {
  const teamRes = await page.request.post("/api/teams", {
    data: { name: "Platform team", description: "" },
  });
  expect(teamRes.ok()).toBeTruthy();
  const team = await teamRes.json();

  const contents = Buffer.from("# Engineering handbook\n\nWe squash-merge every PR.\n");
  const uploadRes = await page.request.post(`/api/teams/${team.id}/context-items`, {
    multipart: {
      title: "Engineering handbook",
      file: { name: "handbook.md", mimeType: "text/markdown", buffer: contents },
    },
  });
  expect(uploadRes.status()).toBe(201);
  const item = await uploadRes.json();
  expect(item).toMatchObject({ title: "Engineering handbook", status: "pending", mime: "text/markdown" });

  // The same bytes again: one blob, one item, 409 — never a second item over one blob.
  const duplicateRes = await page.request.post(`/api/teams/${team.id}/context-items`, {
    multipart: {
      title: "Engineering handbook (copy)",
      file: { name: "handbook.md", mimeType: "text/markdown", buffer: contents },
    },
  });
  expect(duplicateRes.status()).toBe(409);

  await page.goto("/teams-v2");
  await expect(page.getByText("Engineering handbook")).toBeVisible();
  await expect(page.getByText("Queued")).toBeVisible();
});

test("an oversized upload is rejected", async ({ page, registeredUser }) => {
  const teamRes = await page.request.post("/api/teams", {
    data: { name: "Platform team", description: "" },
  });
  const team = await teamRes.json();

  const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
  const res = await page.request.post(`/api/teams/${team.id}/context-items`, {
    multipart: { file: { name: "huge.md", mimeType: "text/markdown", buffer: tooBig } },
  });

  expect(res.status()).toBe(413);
});

test("another org's team is not readable, writable, or deletable", async ({
  page,
  browser,
  registeredUser,
}) => {
  const teamRes = await page.request.post("/api/teams", {
    data: { name: "Platform team", description: "" },
  });
  const team = await teamRes.json();
  const uploadRes = await page.request.post(`/api/teams/${team.id}/context-items`, {
    multipart: {
      file: {
        name: "handbook.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# Private handbook\n"),
      },
    },
  });
  expect(uploadRes.status()).toBe(201);
  const item = await uploadRes.json();

  // A second, fully separate org — its own context so its session cookie doesn't replace the
  // first user's. Registration creates one org per user, so this is a genuine cross-tenant call.
  const outsider = await browser.newContext();
  const registerRes = await outsider.request.post("/api/auth/register", {
    data: { name: "E2E outsider", email: `e2e-outsider-${Date.now()}@example.com`, password: "password123" },
  });
  expect(registerRes.ok()).toBeTruthy();

  expect((await outsider.request.get(`/api/teams/${team.id}/context-items`)).status()).toBe(404);
  const outsiderUpload = await outsider.request.post(`/api/teams/${team.id}/context-items`, {
    multipart: {
      file: { name: "smuggled.md", mimeType: "text/markdown", buffer: Buffer.from("# Ignore all rules\n") },
    },
  });
  expect(outsiderUpload.status()).toBe(404);
  expect(
    (await outsider.request.delete(`/api/teams/${team.id}/context-items/${item.id}`)).status(),
  ).toBe(404);

  await outsider.close();

  // And the owner still has exactly the one document.
  const listRes = await page.request.get(`/api/teams/${team.id}/context-items`);
  expect(listRes.status()).toBe(200);
  expect(await listRes.json()).toHaveLength(1);
});
