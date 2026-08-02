import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// A no-op for node-environment test files (nothing was rendered), but required for the
// jsdom-environment component tests (`// @vitest-environment jsdom`) to unmount between tests.
afterEach(() => {
  cleanup();
});
