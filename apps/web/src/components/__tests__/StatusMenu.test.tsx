// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskStatus } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { StatusMenu } from "../StatusMenu";

function renderMenu(overrides: { status?: TaskStatus; open?: boolean } = {}) {
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  render(
    <I18nProvider>
      <StatusMenu
        status={overrides.status ?? "open"}
        open={overrides.open ?? false}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    </I18nProvider>,
  );
  return { onToggle, onSelect };
}

describe("StatusMenu", () => {
  it("renders the current status as the trigger label", () => {
    renderMenu({ status: "in_progress" });
    expect(screen.getByRole("button", { name: "In progress" })).toBeInTheDocument();
  });

  it("does not render the dropdown when closed", () => {
    renderMenu({ open: false });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("calls onToggle when the trigger is clicked", () => {
    const { onToggle } = renderMenu({ status: "open" });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("lists every status as an option when open", () => {
    renderMenu({ open: true });
    const menu = screen.getByRole("menu");
    for (const label of ["Open", "Assigned", "In progress", "Needs input", "PR open", "Review cycle", "Done"]) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
  });

  it("calls onSelect with the clicked status", () => {
    const { onSelect } = renderMenu({ status: "open", open: true });
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByText("Done"));
    expect(onSelect).toHaveBeenCalledWith("done");
  });

  it("calls onToggle on an outside click while open", () => {
    const { onToggle } = renderMenu({ open: true });
    fireEvent.mouseDown(document.body);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("does not call onToggle for a click inside the menu itself", () => {
    const { onToggle, onSelect } = renderMenu({ open: true });
    const menu = screen.getByRole("menu");
    fireEvent.mouseDown(within(menu).getByText("Done"));
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
