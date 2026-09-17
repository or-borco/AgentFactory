import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          // Mirrors apps/web/tsconfig.json's "@/*" path so component tests can import
          // apps/web modules the same way the app itself does, instead of relative paths.
          alias: {
            "@": path.resolve(__dirname, "apps/web/src"),
          },
        },
        test: {
          name: "unit",
          environment: "node",
          // Individual files opt into jsdom via a `// @vitest-environment jsdom` pragma comment.
          setupFiles: ["./vitest-setup.ts"],
          include: ["**/src/**/__tests__/**/*.test.ts", "**/src/**/__tests__/**/*.test.tsx"],
          exclude: [
            "**/node_modules/**",
            "**/.next/**",
            "**/e2e/**",
            "**/__tests__/repositories/**",
            "packages/queue/src/__tests__/**",
            "apps/web/src/app/api/webhooks/telegram/__tests__/**",
            ".claude/worktrees/**",
          ],
        },
      },
      {
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "apps/web/src"),
          },
        },
        test: {
          name: "db-integration",
          environment: "node",
          include: [
            "packages/db/src/__tests__/repositories/**/*.test.ts",
            "apps/web/src/app/api/webhooks/telegram/__tests__/route.test.ts",
          ],
          exclude: ["**/node_modules/**"],
          // Tests share one truncated database, so files must not run concurrently.
          fileParallelism: false,
        },
      },
      {
        resolve: {
          alias: {
            "@": path.resolve(__dirname, "apps/web/src"),
          },
        },
        test: {
          name: "queue-integration",
          environment: "node",
          include: [
            "packages/queue/src/__tests__/**/*.test.ts",
            "apps/web/src/app/api/webhooks/telegram/__tests__/route.queue.test.ts",
          ],
          exclude: ["**/node_modules/**"],
          // Tests share one Redis queue, so files must not run concurrently.
          fileParallelism: false,
        },
      },
    ],
  },
});
