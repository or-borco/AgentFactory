// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiSelectCheckboxList, type MultiSelectItem } from "../MultiSelectCheckboxList";

const ITEMS: MultiSelectItem[] = [
  { id: 1, label: "Code review" },
  { id: 2, label: "Release notes", sublabel: "Draft only" },
];

describe("MultiSelectCheckboxList", () => {
  it("renders the empty message when there are no items", () => {
    render(
      <MultiSelectCheckboxList items={[]} selectedIds={new Set()} onToggle={vi.fn()} emptyMessage="Nothing here" />,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("checks the boxes matching selectedIds", () => {
    render(<MultiSelectCheckboxList items={ITEMS} selectedIds={new Set([2])} onToggle={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: /Code review/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Release notes/ })).toBeChecked();
  });

  it("calls onToggle with the item's id when its checkbox is clicked", () => {
    const onToggle = vi.fn();
    render(<MultiSelectCheckboxList items={ITEMS} selectedIds={new Set()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Code review/ }));
    expect(onToggle).toHaveBeenCalledWith(1);
  });

  it("disables a checkbox whose id is in disabledIds and does not call onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(
      <MultiSelectCheckboxList items={ITEMS} selectedIds={new Set()} onToggle={onToggle} disabledIds={new Set([1])} />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /Code review/ });
    expect(checkbox).toBeDisabled();
    fireEvent.click(checkbox);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("renders the sublabel when present", () => {
    render(<MultiSelectCheckboxList items={ITEMS} selectedIds={new Set()} onToggle={vi.fn()} />);
    expect(screen.getByText("Draft only")).toBeInTheDocument();
  });

  it("renders trailing content for an item", () => {
    const items: MultiSelectItem[] = [{ id: 1, label: "Code review", trailing: <span>v3</span> }];
    render(<MultiSelectCheckboxList items={items} selectedIds={new Set()} onToggle={vi.fn()} />);
    expect(screen.getByText("v3")).toBeInTheDocument();
  });
});
