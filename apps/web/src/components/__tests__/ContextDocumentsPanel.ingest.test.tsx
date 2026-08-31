// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamContextItem } from "@agentfactory/core";
import { I18nProvider } from "../../lib/i18n/context";
import { ContextDocumentsPanel } from "../ContextDocumentsPanel";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function item(overrides: Partial<TeamContextItem> = {}): TeamContextItem {
  return {
    id: 1,
    teamId: 4,
    orgId: 2,
    title: "Engineering handbook",
    sizeBytes: 18200,
    sha256: "a".repeat(64),
    mime: "text/markdown",
    source: "upload",
    status: "pending",
    createdAt: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <I18nProvider>
      <ContextDocumentsPanel teamId={4} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ContextDocumentsPanel ingest states", () => {
  it("renders an indexed document and stops polling", async () => {
    apiFetchMock.mockResolvedValue([item({ status: "indexed", indexedAt: "2026-08-27T10:00:09.000Z" })]);

    renderPanel();

    await waitFor(() => expect(screen.getByText("Indexed")).toBeInTheDocument());
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders the failure message under a failed document", async () => {
    apiFetchMock.mockResolvedValue([
      item({ status: "failed", error: "Unsupported mime type: application/pdf" }),
    ]);

    renderPanel();

    await waitFor(() => expect(screen.getByText("Failed")).toBeInTheDocument());
    expect(screen.getByText("Indexing failed: Unsupported mime type: application/pdf")).toBeInTheDocument();
  });

  // The whole point of the poll: ingestion happens in another process with no channel back to
  // this tab, so the badge only ever reaches "Indexed" because the list refetched.
  it("polls while a document is still indexing, and reflects the new status", async () => {
    apiFetchMock
      .mockResolvedValueOnce([item({ status: "indexing" })])
      .mockResolvedValue([item({ status: "indexed", indexedAt: "2026-08-27T10:00:09.000Z" })]);

    renderPanel();

    await waitFor(() => expect(screen.getByText("Indexing…")).toBeInTheDocument());
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(screen.getByText("Indexed")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });
});
