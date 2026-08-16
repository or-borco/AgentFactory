// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { AssigneeSelect } from "../AssigneeSelect";

const AGENTS: Agent[] = [
  { id: 1, orgId: 1, name: "Code reviewer" } as Agent,
  { id: 2, orgId: 1, name: "Release notes writer" } as Agent,
];

function renderSelect(overrides: { value?: number; disabled?: boolean } = {}) {
  const onChange = vi.fn();
  render(
    <I18nProvider>
      <AssigneeSelect agents={AGENTS} value={overrides.value} disabled={overrides.disabled} onChange={onChange} />
    </I18nProvider>,
  );
  return { onChange };
}

describe("AssigneeSelect", () => {
  it("shows Unassigned as selected when there's no value", () => {
    renderSelect();
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("shows the matching agent as selected when value is set", () => {
    renderSelect({ value: 2 });
    expect(screen.getByRole("combobox")).toHaveValue("2");
  });

  it("lists every agent plus Unassigned as options", () => {
    renderSelect();
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Unassigned", "Code reviewer", "Release notes writer"]);
  });

  it("calls onChange with the numeric agent id when an agent is picked", () => {
    const { onChange } = renderSelect();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "1" } });
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("calls onChange with undefined when Unassigned is picked", () => {
    const { onChange } = renderSelect({ value: 1 });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("is disabled while saving", () => {
    renderSelect({ disabled: true });
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});
