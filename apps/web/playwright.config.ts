import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // `next dev` rather than `next build && next start` — E2E flows don't need a production
    // build, and skipping it keeps CI simpler (no separate build step/artifact to wire up).
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      // Isolates this run's BullMQ queues from whatever a developer's own `pnpm dev`/`pnpm
      // dev:worker` is pointed at — all worktrees on one machine share the same dev Redis
      // instance (db 0) by default, so without this override a live worker from an unrelated
      // worktree can steal an e2e run's ingest job, then fail to find the blob because it
      // resolves BLOB_DIR against its own worktree's repo root, not this one's. db 2 keeps this
      // separate from both dev (db 0, unset) and test:db/test:queue's .env.test.local (db 1).
      REDIS_URL: "redis://localhost:6379/2",
    },
  },
});
