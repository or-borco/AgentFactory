import { describe, expect, it } from "vitest";
import { resolveDataTheme } from "../resolve-data-theme";

describe("resolveDataTheme", () => {
  it("returns 'light' for an explicit light preference", () => {
    expect(resolveDataTheme("light")).toBe("light");
  });

  it("returns 'dark' for an explicit dark preference", () => {
    expect(resolveDataTheme("dark")).toBe("dark");
  });

  it("returns undefined for 'system' (defers to prefers-color-scheme)", () => {
    expect(resolveDataTheme("system")).toBeUndefined();
  });

  it("returns undefined when there is no preference at all (e.g. logged out)", () => {
    expect(resolveDataTheme(undefined)).toBeUndefined();
  });
});
