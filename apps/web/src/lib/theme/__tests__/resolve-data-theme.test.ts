import { describe, expect, it } from "vitest";
import { resolveDataTheme } from "../resolve-data-theme";

describe("resolveDataTheme", () => {
  it("passes through an explicit light preference", () => {
    expect(resolveDataTheme("light")).toBe("light");
  });

  it("passes through an explicit dark preference", () => {
    expect(resolveDataTheme("dark")).toBe("dark");
  });

  it("omits the attribute for system, so CSS can defer to the OS setting", () => {
    expect(resolveDataTheme("system")).toBeUndefined();
  });

  it("omits the attribute when there is no preference at all (logged out)", () => {
    expect(resolveDataTheme(undefined)).toBeUndefined();
  });
});
