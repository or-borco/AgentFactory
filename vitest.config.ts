import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
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
          ],
        },
      },
      {
        test: {
          name: "db-integration",
          environment: "node",
          include: ["packages/db/src/__tests__/repositories/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          // Tests share one truncated database, so files must not run concurrently.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "queue-integration",
          environment: "node",
          include: ["packages/queue/src/__tests__/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          // Tests share one Redis queue, so files must not run concurrently.
          fileParallelism: false,
        },
      },
    ],
  },
});
