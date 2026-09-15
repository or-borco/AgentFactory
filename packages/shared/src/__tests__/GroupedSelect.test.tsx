// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GroupedSelect, type GroupedSelectOption } from "../GroupedSelect";

const SINGLE_GROUP: GroupedSelectOption[] = [
  { key: "1", value: "acme/platform", label: "acme/platform", group: "github" },
  { key: "2", value: "acme/docs", label: "acme/docs", group: "github" },
];

const MULTI_GROUP: GroupedSelectOption[] = [
  { key: "1", value: "acme/platform", label: "acme/platform", group: "github" },
  { key: "2", value: "acme/site", label: "acme/site", group: "bitbucket" },
];

describe("GroupedSelect", () => {
  it("renders a flat list with no optgroup when only one group is present", () => {
    render(
      <GroupedSelect
        value=""
        onChange={vi.fn()}
        options={SINGLE_GROUP}
        placeholder="Choose a repo"
        groupLabel={(g) => g}
      />,
    );
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "acme/platform" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "acme/docs" })).toBeInTheDocument();
  });

  it("renders a flat list with no optgroup when there are no options at all", () => {
    render(
      <GroupedSelect value="" onChange={vi.fn()} options={[]} placeholder="Choose a repo" groupLabel={(g) => g} />,
    );
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Choose a repo" })).toBeInTheDocument();
  });

  it("groups options into one optgroup per distinct group when more than one is present", () => {
    render(
      <GroupedSelect
        value=""
        onChange={vi.fn()}
        options={MULTI_GROUP}
        placeholder="Choose a repo"
        groupLabel={(g) => (g === "github" ? "GitHub" : "Bitbucket")}
      />,
    );
    const groups = screen.getAllByRole("group") as HTMLOptGroupElement[];
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(["GitHub", "Bitbucket"]);
    expect(screen.getByRole("option", { name: "acme/platform" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "acme/site" })).toBeInTheDocument();
  });

  it("calls onChange with the selected option's value in both the flat and grouped case", () => {
    const onChange = vi.fn();
    render(
      <GroupedSelect
        value=""
        onChange={onChange}
        options={MULTI_GROUP}
        placeholder="Choose a repo"
        groupLabel={(g) => g}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "acme/site" } });
    expect(onChange).toHaveBeenCalledWith("acme/site");
  });

  it("renders extraOptions before the grouped options", () => {
    render(
      <GroupedSelect
        value=""
        onChange={vi.fn()}
        options={MULTI_GROUP}
        placeholder="Choose a repo"
        groupLabel={(g) => g}
        extraOptions={[{ key: "stale", value: "old/repo", label: "old/repo" }]}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.options[0].textContent).toBe("Choose a repo");
    expect(select.options[1].textContent).toBe("old/repo");
  });

  it("passes through native select attributes like className and style", () => {
    render(
      <GroupedSelect
        value=""
        onChange={vi.fn()}
        options={MULTI_GROUP}
        placeholder="Choose a repo"
        groupLabel={(g) => g}
        className="my-class"
        style={{ width: "100%" }}
      />,
    );
    const select = screen.getByRole("combobox");
    expect(select).toHaveClass("my-class");
    expect(select).toHaveStyle({ width: "100%" });
  });
});
