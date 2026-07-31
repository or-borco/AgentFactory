import { test as base } from "@playwright/test";

export interface TestUser {
  name: string;
  email: string;
  password: string;
}

export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function buildUser(label: string): TestUser {
  const suffix = uniqueSuffix();
  return {
    name: `E2E ${label}`,
    email: `e2e-${label}-${suffix}@example.com`,
    password: "password123",
  };
}

export const test = base.extend<{ registeredUser: TestUser }>({
  // Registers a fresh user directly against the API (not through the signup form — that flow is
  // what auth.spec.ts itself exercises) so every other spec starts from a known, authenticated
  // state. Uses `page.request`, not the standalone `request` fixture, so the Set-Cookie response
  // lands in this test's own browser context and subsequent `page.goto` calls are already logged in.
  registeredUser: async ({ page }, use) => {
    const user = buildUser("fixture");
    const res = await page.request.post("/api/auth/register", { data: user });
    if (!res.ok()) {
      throw new Error(`Failed to register fixture user: ${res.status()} ${await res.text()}`);
    }
    await use(user);
  },
});

export { expect } from "@playwright/test";
