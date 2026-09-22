// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { TaskReplyBar } from "../TaskReplyBar";

function renderBar(overrides: Partial<React.ComponentProps<typeof TaskReplyBar>> = {}) {
  const onChange = vi.fn();
  const onSend = vi.fn();
  const onStop = vi.fn();
  const props: React.ComponentProps<typeof TaskReplyBar> = {
    value: "",
    onChange,
    onSend,
    onStop,
    hasSession: true,
    isRunning: false,
    sending: false,
    stopping: false,
    ...overrides,
  };
  render(
    <I18nProvider>
      <TaskReplyBar {...props} />
    </I18nProvider>,
  );
  return { onChange, onSend, onStop };
}

describe("TaskReplyBar", () => {
  it("does not render a Stop button while no run is in flight", () => {
    renderBar({ isRunning: false });
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
  });

  it("renders a Stop button between the textarea and Send while a run is in flight", () => {
    renderBar({ isRunning: true });

    const textarea = screen.getByPlaceholderText(/reply to the agent/i);
    const stopButton = screen.getByRole("button", { name: "Stop" });
    const sendButton = screen.getByRole("button", { name: /send/i });

    // DOM order: textarea, then Stop, then Send.
    const order = [textarea, stopButton, sendButton];
    const container = textarea.closest("div")!;
    const allInOrder = Array.from(container.querySelectorAll("textarea, button"));
    expect(allInOrder).toEqual(order);
  });

  it("calls onStop when the Stop button is clicked, and disables it while stopping", () => {
    const { onStop } = renderBar({ isRunning: true, stopping: false });
    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).not.toBeDisabled();
    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows a stopping state and disables the Stop button while stopping", () => {
    renderBar({ isRunning: true, stopping: true });
    const stopButton = screen.getByRole("button", { name: /stopping/i });
    expect(stopButton).toBeDisabled();
  });

  it("disables the textarea and Send button while a run is in flight", () => {
    renderBar({ isRunning: true, value: "hello" });
    expect(screen.getByPlaceholderText(/reply to the agent/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });

  it("calls onSend when Send is clicked with non-empty text and no run in flight", () => {
    const { onSend } = renderBar({ value: "hello", isRunning: false });
    const sendButton = screen.getByRole("button", { name: /send/i });
    expect(sendButton).not.toBeDisabled();
    fireEvent.click(sendButton);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("disables Send when there is no session, even with text present", () => {
    renderBar({ value: "hello", hasSession: false });
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});
