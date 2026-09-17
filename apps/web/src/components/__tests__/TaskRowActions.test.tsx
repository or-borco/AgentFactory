// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { TaskRowActions } from "../TaskRowActions";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

beforeEach(() => pushMock.mockReset());

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 42,
    orgId: 1,
    ref: "T-42",
    title: "Wire up run cancellation",
    description: "",
    acceptanceCriteria: [],
    status: "assigned",
    assigneeAgentId: 7,
    sessionId: undefined,
    createdBy: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderActions(taskOverrides: Partial<Task> = {}) {
  const onRun = vi.fn().mockResolvedValue(undefined);
  const onMarkDone = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  render(
    <I18nProvider>
      <TaskRowActions task={makeTask(taskOverrides)} onRun={onRun} onMarkDone={onMarkDone} onDelete={onDelete} />
    </I18nProvider>,
  );
  return { onRun, onMarkDone, onDelete };
}

describe("TaskRowActions", () => {
  it("renders all four actions", () => {
    renderActions();
    expect(screen.getByRole("button", { name: "Edit task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as done" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete task" })).toBeInTheDocument();
  });

  it("navigates to the edit page when edit is clicked and no session exists", () => {
    renderActions({ sessionId: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Edit task" }));
    expect(pushMock).toHaveBeenCalledWith("/tasks/42/edit");
  });

  it("disables edit once a session exists", () => {
    renderActions({ sessionId: 99 });
    const editButton = screen.getByRole("button", { name: "Can't edit after a run has started" });
    expect(editButton).toBeDisabled();
    fireEvent.click(editButton);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("enables run and calls onRun when the task is assigned with no session", async () => {
    const { onRun } = renderActions({ status: "assigned", assigneeAgentId: 7, sessionId: undefined });
    const runButton = screen.getByRole("button", { name: "Run agent" });
    expect(runButton).not.toBeDisabled();
    fireEvent.click(runButton);
    await waitFor(() => expect(onRun).toHaveBeenCalled());
  });

  it("disables run with a no-agent tooltip when unassigned", () => {
    renderActions({ status: "open", assigneeAgentId: undefined, sessionId: undefined });
    const runButton = screen.getByRole("button", { name: "Assign an agent before running" });
    expect(runButton).toBeDisabled();
  });

  it("disables run with an already-started tooltip once a session exists", () => {
    renderActions({ status: "assigned", assigneeAgentId: 7, sessionId: 99 });
    const runButton = screen.getByRole("button", { name: "Already started" });
    expect(runButton).toBeDisabled();
  });

  it("calls onMarkDone when clicked on a non-done task", async () => {
    const { onMarkDone } = renderActions({ status: "in_progress" });
    fireEvent.click(screen.getByRole("button", { name: "Mark as done" }));
    await waitFor(() => expect(onMarkDone).toHaveBeenCalled());
  });

  it("disables mark-done once the task is already done", () => {
    renderActions({ status: "done" });
    expect(screen.getByRole("button", { name: "Mark as done" })).toBeDisabled();
  });

  it("opens a confirm dialog on delete, and calls onDelete when confirmed", async () => {
    const { onDelete } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    expect(screen.getByText("Delete 'Wire up run cancellation'?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalled());
  });

  it("does not call onDelete when the confirm dialog is cancelled", () => {
    const { onDelete } = renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Delete 'Wire up run cancellation'?")).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("renders the confirm dialog outside the fading action cluster wrapper", () => {
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));
    const dialogHeading = screen.getByText("Delete 'Wire up run cancellation'?");
    const fadingWrapper = screen.getByRole("button", { name: "Edit task" }).closest("div.opacity-0");
    expect(fadingWrapper).not.toBeNull();
    expect(fadingWrapper).not.toContainElement(dialogHeading);
  });
});
