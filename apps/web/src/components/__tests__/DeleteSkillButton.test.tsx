// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { DeleteSkillButton } from "../DeleteSkillButton";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function renderButton(overrides: { assignedAgentNames?: string[] } = {}) {
  const onDeleted = vi.fn();
  const onError = vi.fn();
  render(
    <I18nProvider>
      <DeleteSkillButton
        skillId={9}
        skillName="Conventional commits"
        assignedAgentNames={overrides.assignedAgentNames ?? []}
        onDeleted={onDeleted}
        onError={onError}
      />
    </I18nProvider>,
  );
  return { onDeleted, onError };
}

beforeEach(() => apiFetchMock.mockReset());

describe("DeleteSkillButton", () => {
  it("is enabled when no agents are assigned", () => {
    renderButton();
    expect(screen.getByRole("button", { name: /Delete/ })).not.toBeDisabled();
  });

  it("is disabled and shows a tooltip listing the assigned agents when any are assigned", () => {
    renderButton({ assignedAgentNames: ["Coding agent", "Review agent"] });
    expect(screen.getByRole("button", { name: /Delete/ })).toBeDisabled();
    expect(
      screen.getByText("Assigned to Coding agent, Review agent. Unassign from these agents before deleting."),
    ).toBeInTheDocument();
  });

  it("opens a confirm dialog when clicked while enabled", () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(screen.getByText("Delete 'Conventional commits'?")).toBeInTheDocument();
  });

  it("deletes the skill and calls onDeleted when confirmed", async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { onDeleted } = renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    // Two "Delete" buttons exist once the dialog is open: the (now-hidden-behind-the-modal)
    // trigger, and the dialog's own confirm button, which renders second in DOM order.
    const [, confirmButton] = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/skills/9", { method: "DELETE" }));
    expect(onDeleted).toHaveBeenCalled();
  });

  it("calls onError and closes the dialog when deletion fails", async () => {
    // mockRejectedValueOnce (not the persistent mockRejectedValue): this codebase's other
    // reject-path tests all use the queued "Once" form, and the persistent form triggers a
    // false-positive unhandled-rejection failure from this test's own tooling even though the
    // component's try/catch runs and completes correctly (confirmed by instrumenting it). The
    // "Once" form calls the mock exactly the same way for this test's single apiFetch call.
    apiFetchMock.mockRejectedValueOnce(new Error("Skill is assigned to an agent; unassign it first"));
    const { onError } = renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    const [, confirmButton] = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Skill is assigned to an agent; unassign it first"));
    expect(screen.queryByText("Delete 'Conventional commits'?")).not.toBeInTheDocument();
  });
});
