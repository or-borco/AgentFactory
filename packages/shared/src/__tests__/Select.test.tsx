// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "../Select";

const OPTIONS: SelectOption[] = [
  { key: "1", value: "acme/platform", label: "acme/platform" },
  { key: "2", value: "acme/docs", label: "acme/docs" },
];

describe("Select", () => {
  it("renders the placeholder as the empty-value option", () => {
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} placeholder="Choose a repo" />);
    expect(screen.getByRole("option", { name: "Choose a repo" })).toHaveValue("");
  });

  it("renders every option", () => {
    render(<Select value="" onChange={vi.fn()} options={OPTIONS} placeholder="Choose a repo" />);
    expect(screen.getByRole("option", { name: "acme/platform" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "acme/docs" })).toBeInTheDocument();
  });

  it("calls onChange with the selected option's value", () => {
    const onChange = vi.fn();
    render(<Select value="" onChange={onChange} options={OPTIONS} placeholder="Choose a repo" />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "acme/docs" } });
    expect(onChange).toHaveBeenCalledWith("acme/docs");
  });

  it("renders extraOptions before the main options list", () => {
    render(
      <Select
        value=""
        onChange={vi.fn()}
        options={OPTIONS}
        placeholder="Choose a repo"
        extraOptions={[{ key: "stale", value: "old/repo", label: "old/repo" }]}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["Choose a repo", "old/repo", "acme/platform", "acme/docs"]);
  });

  it("passes through native select attributes like className and style", () => {
    render(
      <Select
        value=""
        onChange={vi.fn()}
        options={OPTIONS}
        placeholder="Choose a repo"
        className="my-class"
        style={{ width: "100%" }}
      />,
    );
    const select = screen.getByRole("combobox");
    expect(select).toHaveClass("my-class");
    expect(select).toHaveStyle({ width: "100%" });
  });
});
