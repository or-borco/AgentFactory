// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n/context";
import { WriteBackFailureBanner } from "../WriteBackFailureBanner";
import type { Task } from "@agentfactory/core";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    orgId: 1,
    ref: "T-1",
    title: "Fix the thing",
    description: "",
    acceptanceCriteria: [],
    status: "in_progress",
    createdBy: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => apiFetchMock.mockReset());

describe("WriteBackFailureBanner", () => {
  it("renders nothing when there is no externalRef", () => {
    const { container } = render(
      <I18nProvider>
        <WriteBackFailureBanner task={baseTask()} onDismiss={vi.fn()} />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when externalRef has no writeBackFailure", () => {
    const task = baseTask({
      externalRef: { provider: "jira", key: "PROJ-1", url: "https://x.atlassian.net/browse/PROJ-1", lastKnownUpdated: "2026-09-01T00:00:00.000Z" },
    });
    const { container } = render(
      <I18nProvider>
        <WriteBackFailureBanner task={task} onDismiss={vi.fn()} />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the failure message and a link to the provider when writeBackFailure is set", () => {
    const task = baseTask({
      externalRef: {
        provider: "jira",
        key: "PROJ-1",
        url: "https://x.atlassian.net/browse/PROJ-1",
        lastKnownUpdated: "2026-09-01T00:00:00.000Z",
        writeBackFailure: { message: "Atlassian is down", occurredAt: "2026-09-02T00:00:00.000Z" },
      },
    });
    render(
      <I18nProvider>
        <WriteBackFailureBanner task={task} onDismiss={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText("Atlassian is down")).toBeInTheDocument();
    const link = screen.getByText("View in Jira") as HTMLAnchorElement;
    expect(link.href).toBe("https://x.atlassian.net/browse/PROJ-1");
  });

  it("clears writeBackFailure via PATCH and calls onDismiss when Dismiss is clicked", async () => {
    apiFetchMock.mockResolvedValue({});
    const onDismiss = vi.fn();
    const task = baseTask({
      externalRef: {
        provider: "jira",
        key: "PROJ-1",
        url: "https://x.atlassian.net/browse/PROJ-1",
        lastKnownUpdated: "2026-09-01T00:00:00.000Z",
        writeBackFailure: { message: "Atlassian is down", occurredAt: "2026-09-02T00:00:00.000Z" },
      },
    });
    render(
      <I18nProvider>
        <WriteBackFailureBanner task={task} onDismiss={onDismiss} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("Dismiss"));

    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/tasks/1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          externalRef: {
            provider: "jira",
            key: "PROJ-1",
            url: "https://x.atlassian.net/browse/PROJ-1",
            lastKnownUpdated: "2026-09-01T00:00:00.000Z",
            writeBackFailure: undefined,
          },
        }),
      }),
    );
  });
});
