// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../Button";

describe("Button", () => {
  it("renders its children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Save
      </Button>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("applies secondary variant styles instead of primary", () => {
    render(<Button variant="secondary">Cancel</Button>);
    const button = screen.getByRole("button", { name: "Cancel" });

    expect(button.className).toContain("border-[var(--color-divider)]");
    expect(button.className).not.toContain("bg-[var(--color-accent-800)]");
  });

  it("merges a custom className with its base styles", () => {
    render(<Button className="w-full">Full width</Button>);
    expect(screen.getByRole("button", { name: "Full width" }).className).toContain("w-full");
  });
});
