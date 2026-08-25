// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "../Badge";

describe("Badge", () => {
  it("renders its children", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("defaults to the neutral tone", () => {
    render(<Badge>Default</Badge>);
    expect(screen.getByText("Default").className).toContain("text-[var(--color-neutral-500)]");
  });

  it("applies the success tone", () => {
    render(<Badge tone="success">Done</Badge>);
    expect(screen.getByText("Done").className).toContain("var(--color-status-green)");
  });

  it("applies the warning tone", () => {
    render(<Badge tone="warning">Pending</Badge>);
    expect(screen.getByText("Pending").className).toContain("var(--color-status-amber)");
  });
});
