// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { TaskReplyBar } from "../TaskReplyBar";

function renderBar(overrides: Partial<React.ComponentProps<typeof TaskReplyBar>> = {}) {
  const props = {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    disabled: false,
    sending: false,
    isRunning: false,
    stopping: false,
    ...overrides,
  };
  render(
    <I18nProvider>
      <TaskReplyBar {...props} />
    </I18nProvider>,
  );
  return props;
}

describe("TaskReplyBar", () => {
  it("hides the Stop button when no run is active", () => {
    renderBar({ isRunning: false });
    expect(screen.queryByRole("button", { name: /stop agent/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^send$/i })).toBeInTheDocument();
  });

  it("shows a Stop button between the textarea and Send while a run is active", () => {
    const { container } = render(
      <I18nProvider>
        <TaskReplyBar
          value="hello"
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onStop={vi.fn()}
          disabled={false}
          sending={false}
          isRunning
          stopping={false}
        />
      </I18nProvider>,
    );

    // This flex row renders its children in visual left-to-right order, so DOM order tells
    // us Stop sits between the textarea and Send, as the composer expects.
    const tags = Array.from(container.querySelectorAll("textarea, button")).map((el) =>
      el.tagName === "TEXTAREA" ? "textarea" : el.getAttribute("aria-label") ?? el.textContent,
    );
    expect(tags).toEqual(["textarea", "Stop agent", "Send"]);
  });

  it("calls onStop when the Stop button is clicked", () => {
    const props = renderBar({ isRunning: true });
    fireEvent.click(screen.getByRole("button", { name: /stop agent/i }));
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it("disables Stop and shows a stopping label while a stop request is in flight", () => {
    renderBar({ isRunning: true, stopping: true });
    // The aria-label stays "Stop agent" for a stable accessible name; the visible label swaps to "Stopping…".
    const stopButton = screen.getByRole("button", { name: /stop agent/i });
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveTextContent(/stopping/i);
  });

  it("disables Send when the input is empty even if a run isn't active", () => {
    renderBar({ value: "" });
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();
  });

  it("enables Send once there is non-whitespace input and calls onSubmit when clicked", () => {
    const props = renderBar({ value: "hi there" });
    const sendButton = screen.getByRole("button", { name: /^send$/i });
    expect(sendButton).toBeEnabled();
    fireEvent.click(sendButton);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables Send and the textarea when disabled is true, regardless of input", () => {
    renderBar({ value: "hi there", disabled: true });
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();
    expect(screen.getByPlaceholderText(/reply to the agent/i)).toBeDisabled();
  });

  it("submits on Enter and inserts a newline (does not submit) on Shift+Enter", () => {
    const props = renderBar({ value: "hi" });
    const textbox = screen.getByPlaceholderText(/reply to the agent/i);

    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: false });
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("calls onChange as the user types", () => {
    const props = renderBar();
    fireEvent.change(screen.getByPlaceholderText(/reply to the agent/i), { target: { value: "new text" } });
    expect(props.onChange).toHaveBeenCalledWith("new text");
  });
});
